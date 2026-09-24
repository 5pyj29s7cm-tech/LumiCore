"""Isolated offline scorer adaptation. Never imported by the production runtime.

Fit reads train/calibration only. Evaluate requires a sealed fit manifest and
refuses to replace an earlier held-out result. No tool execution or promotion.
"""
import argparse
import copy
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import time

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                  HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false', USE_TF='0')

QUESTION = {
    'type': 'choice',
    'instructions': 'Does the current user message explicitly request continuing, retrying, or modifying the given existing task now? Status questions, stop requests, quotations, future conditions, unrelated tasks, and a missing existing task are OTHER.',
    'criteria': {
        'OTHER': 'No explicit request to continue the given existing task now.',
        'CONTINUE': 'Explicit request to continue, retry, or modify the given existing task now.',
    },
}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def state_for(row):
    # Do not leak the target, example ID, category or index-derived status.
    task = row.get('task')
    return {'current_user_message': row['text'],
            'existing_task': {'goal': task['goal']} if task is not None else None}


def read_split(data, name, protocol):
    path = data / (name + '.json')
    assert sha(path) == protocol['files'][name]['sha256'], 'frozen split changed'
    rows = read_json(path)
    assert len(rows) == protocol['files'][name]['n']
    assert sum(r['label'] for r in rows) == protocol['files'][name]['positives']
    assert len({r['id'] for r in rows}) == len(rows)
    assert all(r['label'] in (0, 1) for r in rows)
    return rows


def summarize(probabilities, labels, threshold):
    """probabilities shape [case, order, canonical label]. All cases counted."""
    import torch
    individual = probabilities.argmax(-1)
    consensus = individual[:, 0] == individual[:, 1]
    average = probabilities.mean(1)
    predicted = average.argmax(-1)
    certainty = probabilities.max(-1).values.min(-1).values
    accepted = consensus & (certainty >= threshold)
    correct = predicted == labels
    positives = labels == 1
    false_positive = (predicted == 1) & ~positives
    true_positive = (predicted == 1) & positives
    accepted_count = int(accepted.sum())
    positive_predictions = int(((predicted == 1) & accepted).sum())
    return {
        'n': len(labels), 'correct': int(correct.sum()),
        'rawAccuracy': float(correct.float().mean()),
        'accuracyByOrder': [float((individual[:, i] == labels).float().mean()) for i in (0, 1)],
        'orderAgreement': float(consensus.float().mean()),
        'rawFalsePositiveContinuations': int(false_positive.sum()),
        'rawFalseNegatives': int(((predicted == 0) & positives).sum()),
        'selectiveAccepted': accepted_count, 'selectiveAbstained': len(labels) - accepted_count,
        'selectiveCoverage': float(accepted.float().mean()),
        'selectiveAccuracy': float(correct[accepted].float().mean()) if accepted_count else None,
        'selectiveFalsePositiveContinuations': int((false_positive & accepted).sum()),
        'selectiveTruePositiveContinuations': int((true_positive & accepted).sum()),
        'selectiveContinuationRecall': float((true_positive & accepted).sum() / positives.sum()) if positives.any() else None,
        'selectiveContinuationPrecision': float((true_positive & accepted).sum() / positive_predictions) if positive_predictions else None,
        'threshold': threshold,
    }


def select_threshold(probabilities, labels):
    # Only calibration is permitted here. Require agreement, allow abstention.
    candidates = {0.75, 1.000001}
    for value in probabilities.max(-1).values.min(-1).values.tolist():
        if value >= 0.75:
            candidates.add(float(value))
            candidates.add(float(value) + 1e-7)
    eligible = []
    for threshold in sorted(candidates):
        metrics = summarize(probabilities, labels, threshold)
        if metrics['selectiveFalsePositiveContinuations'] == 0:
            eligible.append(metrics)
    # Prefer maximal coverage; lowest threshold breaks ties deterministically.
    return max(eligible, key=lambda m: (m['selectiveAccepted'], -m['threshold']))


def load_agent(base):
    import torch
    import laya
    assert base.is_absolute() and (base / 'model.safetensors').is_file()
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    started = time.perf_counter()
    agent = laya.load(str(base), device='cpu')
    agent.model.eval()
    for parameter in agent.model.parameters():
        parameter.requires_grad_(False)
    print(json.dumps({'phase': 'loaded', 'seconds': round(time.perf_counter() - started, 2)}), flush=True)
    return agent


def features(agent, rows, split_name):
    import torch
    from laya.common import build_sequence, render_options, serialize_state
    q = agent._to_internal(QUESTION)
    output, durations = [], []
    checked_against_forward = False
    for row in rows:
        state = state_for(row)
        tok = agent.tok
        head = len(tok(q['t'] + ' question: ' + q['ins'], add_special_tokens=False)['input_ids'])
        options = [1 + len(tok(' ' + v, add_special_tokens=False)['input_ids']) for v in render_options(q)]
        state_length = len(tok(serialize_state(state), add_special_tokens=False)['input_ids'])
        assert max(options) <= 49 and sum(options) + head <= agent.cfg['head_max_len'], 'head truncation'
        assert sum(options) + head + state_length + 4 <= agent.cfg['max_len'], 'state truncation'
        pair = []
        for order in ([0, 1], [1, 0]):
            ids, markers = build_sequence(tok, state, q, agent.cfg['max_len'], agent.cfg['head_max_len'], order)
            assert len(markers) == 2
            input_ids = torch.tensor([ids], dtype=torch.long)
            attention = torch.ones_like(input_ids)
            positions = torch.tensor([markers], dtype=torch.long)
            qtype = torch.zeros(1, dtype=torch.long)
            started = time.perf_counter()
            with torch.no_grad():
                model = agent.model
                h = model.encoder(input_ids=input_ids, attention_mask=attention).last_hidden_state
                h = h + model.type_emb(qtype)[:, None, :]
                if model.head is not None:
                    for layer in model.head.layers:
                        h = layer(h, src_key_padding_mask=~attention.bool())
                m = torch.gather(h, 1, positions[:, :, None].expand(-1, -1, h.size(-1)))
                # Ensure feature extraction is exactly the shipped scoring path.
                if not checked_against_forward:
                    expected, _ = model(input_ids, attention, positions, torch.ones_like(positions, dtype=torch.bool), qtype)
                    torch.testing.assert_close(model.scorer(m).squeeze(-1), expected, rtol=1e-5, atol=1e-6)
                    checked_against_forward = True
            durations.append(time.perf_counter() - started)
            # Restore OTHER, CONTINUE column order before scorer training.
            pair.append(m[0, order].clone())
        output.append(torch.stack(pair))
        if len(output) % 8 == 0 or len(output) == len(rows):
            print(json.dumps({'phase': 'features', 'split': split_name, 'done': len(output), 'total': len(rows)}), flush=True)
    return torch.stack(output), {'totalSeconds': sum(durations),
        'meanMsPerOrder': 1000 * sum(durations) / len(durations),
        'p95MsPerOrder': 1000 * sorted(durations)[min(len(durations)-1, int(len(durations)*0.95))]}


def fit(args):
    import torch
    from safetensors.torch import save_file, load_file
    data, out, base = args.data.resolve(), args.out.resolve(), args.base.resolve()
    assert not (out / 'manifest.json').exists(), 'sealed fit already exists'
    out.mkdir(parents=True, exist_ok=True)
    protocol = read_json(data / 'protocol.json')
    assert protocol['version'] == 2
    torch.manual_seed(protocol['seed'])
    train = read_split(data, 'train', protocol)
    calibration = read_split(data, 'calibration', protocol)
    assert not ({r['text'] for r in train} & {r['text'] for r in calibration}), 'split text leakage'
    base_hash = sha(base / 'model.safetensors')
    agent = load_agent(base)
    train_x, train_timing = features(agent, train, 'train')
    calibration_x, calibration_timing = features(agent, calibration, 'calibration')
    train_y = torch.tensor([r['label'] for r in train]).repeat_interleave(2)
    calibration_y = torch.tensor([r['label'] for r in calibration]).repeat_interleave(2)
    train_x = train_x.flatten(0, 1)
    calibration_x_flat = calibration_x.flatten(0, 1)
    scorer = copy.deepcopy(agent.model.scorer)
    for parameter in scorer.parameters():
        parameter.requires_grad_(True)
    optimizer = torch.optim.AdamW(scorer.parameters(), lr=protocol['learningRate'], weight_decay=protocol['weightDecay'])
    loss_fn = torch.nn.CrossEntropyLoss()
    history, best = [], None
    started = time.perf_counter()
    for epoch in range(protocol['epochs'] + 1):
        if epoch:
            scorer.train()
            indices = torch.randperm(len(train_x))
            for batch in indices.split(protocol['batchSize']):
                optimizer.zero_grad(set_to_none=True)
                logits = scorer(train_x[batch]).squeeze(-1)
                loss = loss_fn(logits, train_y[batch])
                assert torch.isfinite(loss)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(scorer.parameters(), 1.0)
                optimizer.step()
        scorer.eval()
        with torch.no_grad():
            train_logits = scorer(train_x).squeeze(-1)
            cal_logits = scorer(calibration_x_flat).squeeze(-1)
            record = {'epoch': epoch, 'trainLoss': float(loss_fn(train_logits, train_y)),
                      'calibrationLoss': float(loss_fn(cal_logits, calibration_y)),
                      'calibrationAccuracyBothOrders': float((cal_logits.argmax(-1) == calibration_y).float().mean())}
        history.append(record)
        if best is None or record['calibrationLoss'] < best['calibrationLoss']:
            best = dict(record)
            best_weights = {k: v.detach().clone() for k, v in scorer.state_dict().items()}
        if epoch % 10 == 0:
            print(json.dumps({'phase': 'fit', **record}), flush=True)
    scorer.load_state_dict(best_weights)
    scorer.eval()
    with torch.no_grad():
        cal_logits = scorer(calibration_x_flat).squeeze(-1)
        temperatures = [1 + i / 10 for i in range(41)]
        temperature = min(temperatures, key=lambda t: float(loss_fn(cal_logits / t, calibration_y)))
        probabilities = (cal_logits / temperature).softmax(-1).reshape(-1, 2, 2)
        calibrated = select_threshold(probabilities, calibration_y[::2])
        baseline_prob = agent.model.scorer(calibration_x_flat).squeeze(-1).softmax(-1).reshape(-1, 2, 2)
    checkpoint = out / 'scorer.safetensors'
    save_file(best_weights, str(checkpoint), metadata={'scope': 'experimental-continuation-only', 'controlsExecution': 'false'})
    reloaded = copy.deepcopy(scorer)
    reloaded.load_state_dict(load_file(str(checkpoint)), strict=True)
    with torch.no_grad():
        torch.testing.assert_close(reloaded(calibration_x_flat), scorer(calibration_x_flat), rtol=0, atol=0)
    assert sha(base / 'model.safetensors') == base_hash, 'base weights changed'
    write_json(out / 'training-history.json', history)
    manifest = {
        'schema': 1, 'sealedAtUnix': time.time(), 'controlsExecution': False,
        'scope': 'existing-task continuation; isolated scorer-only experiment',
        'data': str(data), 'base': str(base), 'baseWeightSha256': base_hash,
        'scriptSha256': sha(__file__), 'protocolSha256': sha(data / 'protocol.json'),
        'scorerSha256': sha(checkpoint), 'question': QUESTION,
        'inputFields': ['current_user_message', 'existing_task.goal'],
        'sdkVersion': importlib.metadata.version('laya'), 'torchVersion': torch.__version__,
        'trainedParameters': sum(p.numel() for p in scorer.parameters()),
        'frozenEncoderAndTransformerHead': True, 'savedScorerReloadIdentical': True,
        'selection': best, 'temperature': temperature, 'threshold': calibrated['threshold'],
        'calibration': calibrated, 'baselineCalibration': summarize(baseline_prob, calibration_y[::2], 0.75),
        'trainingSeconds': time.perf_counter()-started,
        'featureTiming': {'train': train_timing, 'calibration': calibration_timing},
        'testReadDuringFit': False, 'acceptance': protocol['acceptance'],
    }
    write_json(out / 'manifest.json', manifest)
    print(json.dumps({'phase': 'sealed', 'selection': best, 'calibration': calibrated}), flush=True)


def evaluate(args):
    import torch
    from safetensors.torch import load_file
    data, out, base = args.data.resolve(), args.out.resolve(), args.base.resolve()
    assert not (out / 'heldout-result.json').exists(), 'held-out result already exists; do not tune on it'
    manifest = read_json(out / 'manifest.json')
    assert manifest['scriptSha256'] == sha(__file__), 'evaluation implementation changed after fit'
    assert manifest['protocolSha256'] == sha(data / 'protocol.json')
    assert manifest['scorerSha256'] == sha(out / 'scorer.safetensors')
    assert manifest['baseWeightSha256'] == sha(base / 'model.safetensors')
    assert manifest['question'] == QUESTION and manifest['controlsExecution'] is False
    protocol = read_json(data / 'protocol.json')
    rows = read_split(data, 'test', protocol)
    # Audit overlap without fitting anything or changing the sealed checkpoint.
    earlier = read_split(data, 'train', protocol) + read_split(data, 'calibration', protocol)
    assert not ({r['text'] for r in rows} & {r['text'] for r in earlier}), 'test text leakage'
    assert not ({r['scenario'] for r in rows} - {'no_task'}) & {r['scenario'] for r in earlier}, 'test domain leakage'
    labels = torch.tensor([r['label'] for r in rows])
    agent = load_agent(base)
    x, timing = features(agent, rows, 'test')
    scorer = copy.deepcopy(agent.model.scorer)
    scorer.load_state_dict(load_file(str(out / 'scorer.safetensors')), strict=True)
    scorer.eval()
    with torch.no_grad():
        baseline = agent.model.scorer(x).squeeze(-1).softmax(-1)
        probabilities = (scorer(x).squeeze(-1) / manifest['temperature']).softmax(-1)
    metrics = summarize(probabilities, labels, manifest['threshold'])
    baseline_metrics = summarize(baseline, labels, 0.75)
    gates = {
        'rawAccuracy': metrics['rawAccuracy'] >= manifest['acceptance']['rawAccuracy'],
        'orderAgreement': metrics['orderAgreement'] >= manifest['acceptance']['orderAgreement'],
        'falsePositiveContinuations': metrics['selectiveFalsePositiveContinuations'] == 0,
        'selectiveCoverage': metrics['selectiveCoverage'] >= manifest['acceptance']['selectiveCoverage'],
    }
    records = []
    for i, row in enumerate(rows):
        probs = probabilities[i]
        prediction = int(probs.mean(0).argmax())
        accepted = bool(probs.argmax(-1)[0] == probs.argmax(-1)[1] and probs.max(-1).values.min() >= manifest['threshold'])
        records.append({**row, 'predicted': prediction, 'accepted': accepted,
            'correct': prediction == row['label'], 'continueProbabilityByOrder': probs[:, 1].tolist(),
            'baselinePredicted': int(baseline[i].mean(0).argmax())})
    result = {'manifestSha256': sha(out / 'manifest.json'), 'testSha256': sha(data / 'test.json'),
        'syntheticOnly': True, 'independentHumanLabels': False, 'controlsExecution': False,
        'trained': metrics, 'baselineSameBinaryQuestion': baseline_metrics,
        'gates': gates, 'passedSyntheticGate': all(gates.values()), 'productionPromotion': False,
        'featureTiming': timing, 'records': records}
    write_json(out / 'heldout-result.json', result)
    print(json.dumps({k: v for k, v in result.items() if k != 'records'}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['fit', 'evaluate'])
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--base', type=Path, required=True)
    arguments = parser.parse_args()
    {'fit': fit, 'evaluate': evaluate}[arguments.command](arguments)

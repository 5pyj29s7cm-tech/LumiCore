"""Offline, CPU-only observer. stdin/stdout JSONL; no tools, network or durable chat log."""
import os
import sys
import json
import contextlib
from pathlib import Path

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                  TOKENIZERS_PARALLELISM='false', USE_TF='0')
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')

QUESTIONS = {
    'followup': {'type': 'choice', 'instructions': 'Classify how the current user message relates to the existing task. A new independent request is none. A progress question never authorizes retry.',
        'criteria': {'execute': 'Continue, retry, or modify the existing task now.', 'status': 'Report saved task progress or result without repeating it.',
                     'repeat': 'Repeat the last spoken explanation, not a tool action.', 'none': 'New request, ordinary conversation, or no continuation.'}},
    'skill': {'type': 'choice', 'instructions': 'Classify the skill/workflow operation explicitly requested NOW. Questions about past completion, explanations and prohibitions authorize no operation.',
        'criteria': {'save': 'Save completed work as a reusable workflow recipe.', 'generate': 'Create a skill package draft.',
                     'use': 'Run an existing skill or workflow.', 'install': 'Install an existing skill package.',
                     'publish': 'Publish a skill or workflow.', 'none': 'No current skill operation requested.'}},
}

def main():
    model_path = Path(sys.argv[1])
    if not model_path.is_absolute() or not (model_path / 'model.safetensors').is_file():
        raise ValueError('local_model_required')
    # Keep third-party progress/messages away from the protocol channel.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import laya
        from laya.common import render_options, serialize_state
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        agent = laya.load(str(model_path), device='cpu')
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        if len(line) > 16_384:
            break
        request_id = None
        try:
            request = json.loads(line)
            request_id = request['id']
            state = request['state']
            # Do not silently drop the newest instruction or task state.
            state_len = len(agent.tok(serialize_state(state), add_special_tokens=False)['input_ids'])
            for question in QUESTIONS.values():
                q = agent._to_internal(question)
                opts = [1 + len(agent.tok(' ' + value, add_special_tokens=False)['input_ids']) for value in render_options(q)]
                head = len(agent.tok(q['t'] + ' question: ' + q['ins'], add_special_tokens=False)['input_ids'])
                if max(opts) > 49 or sum(opts)+head > agent.cfg['head_max_len'] or sum(opts)+head+state_len+4 > agent.cfg['max_len']:
                    raise ValueError('input_too_long')
            with contextlib.redirect_stdout(sys.stderr):
                result = agent.predict(state, QUESTIONS)
            answer = {'id': request_id}
            for name in QUESTIONS:
                decision = result['answers'][name]
                answer[name] = {'choice': decision['choice'], 'confidence': decision['confidence']}
            print(json.dumps(answer), flush=True)
        except Exception as error:
            print(json.dumps({'id': request_id, 'error': 'input_too_long' if str(error)=='input_too_long' else 'inference_failed'}), flush=True)

if __name__ == '__main__':
    main()

"""Checks for experiment leakage and unsafe selective-metric accounting."""
import unittest
import torch
from continuation_experiment import state_for, select_threshold, summarize


class ExperimentTests(unittest.TestCase):
    def test_only_message_and_goal_enter_input(self):
        row = {'text': '继续', 'task': {'goal': '导出', 'status': 'blocked'},
               'id': 'test-001', 'label': 1, 'scenario': 'video', 'family': 'resume'}
        changed = {**row, 'id': 'test-999', 'label': 0, 'family': 'stop',
                   'task': {'goal': '导出', 'status': 'completed'}}
        self.assertEqual(state_for(row), state_for(changed))
        self.assertEqual(state_for(row), {'current_user_message': '继续', 'existing_task': {'goal': '导出'}})

    def test_missing_task_stays_explicitly_missing(self):
        self.assertIsNone(state_for({'text': '继续', 'task': None})['existing_task'])

    def test_option_disagreement_abstains(self):
        probs = torch.tensor([[[.01, .99], [.99, .01]]])
        result = summarize(probs, torch.tensor([0]), .75)
        self.assertEqual(result['selectiveAccepted'], 0)
        self.assertEqual(result['orderAgreement'], 0)

    def test_confident_wrong_continuation_is_not_hidden(self):
        probs = torch.tensor([[[.01, .99], [.02, .98]]])
        result = summarize(probs, torch.tensor([0]), .75)
        self.assertEqual(result['rawFalsePositiveContinuations'], 1)
        self.assertEqual(result['selectiveFalsePositiveContinuations'], 1)
        self.assertEqual(result['selectiveAccuracy'], 0)

    def test_calibration_may_abstain_everywhere(self):
        probs = torch.tensor([[[0., 1.], [0., 1.]]])
        result = select_threshold(probs, torch.tensor([0]))
        self.assertEqual(result['selectiveAccepted'], 0)
        self.assertGreater(result['threshold'], 1)
        self.assertIsNone(result['selectiveAccuracy'])

    def test_high_negative_coverage_does_not_hide_zero_recall(self):
        probs = torch.tensor([[[.9, .1], [.9, .1]], [[.9, .1], [.9, .1]]])
        result = summarize(probs, torch.tensor([0, 1]), .75)
        self.assertEqual(result['selectiveCoverage'], 1)
        self.assertEqual(result['rawAccuracy'], .5)
        self.assertEqual(result['selectiveContinuationRecall'], 0)
        self.assertIsNone(result['selectiveContinuationPrecision'])

    def test_calibration_threshold_excludes_false_positive(self):
        probs = torch.tensor([[[.1, .9], [.1, .9]], [[.2, .8], [.2, .8]]])
        result = select_threshold(probs, torch.tensor([1, 0]))
        self.assertEqual(result['selectiveAccepted'], 1)
        self.assertEqual(result['selectiveTruePositiveContinuations'], 1)
        self.assertEqual(result['selectiveFalsePositiveContinuations'], 0)


if __name__ == '__main__':
    unittest.main()

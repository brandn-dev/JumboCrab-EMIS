import unittest

from challenge_state import evaluate_action_sequence


def metric(yaw=0.0, blink=0.1):
    return {"yaw": yaw, "blink": blink}


def evaluate(metrics, actions):
    return evaluate_action_sequence(
        metrics,
        actions,
        center_yaw=0.10,
        turn_yaw=0.18,
        blink_open_score=0.25,
        blink_closed_score=0.55,
    )


class ChallengeStateTests(unittest.TestCase):
    def test_blink_then_left_turn_passes(self):
        metrics = [metric() for _ in range(24)]
        metrics[5] = metric(blink=0.8)
        metrics[13] = metric(yaw=0.24)
        metrics[14] = metric(yaw=0.25)
        results, representatives = evaluate(metrics, ["BLINK", "TURN_LEFT"])
        self.assertEqual([row["action"] for row in results], ["BLINK", "TURN_LEFT"])
        self.assertEqual(len(representatives), 5)

    def test_right_turn_then_blink_passes(self):
        metrics = [metric() for _ in range(24)]
        metrics[5] = metric(yaw=-0.24)
        metrics[6] = metric(yaw=-0.25)
        metrics[14] = metric(blink=0.8)
        results, _ = evaluate(metrics, ["TURN_RIGHT", "BLINK"])
        self.assertEqual([row["action"] for row in results], ["TURN_RIGHT", "BLINK"])

    def test_static_selfie_fails(self):
        with self.assertRaisesRegex(ValueError, "wrong_action_order"):
            evaluate([metric() for _ in range(24)], ["BLINK", "TURN_LEFT"])

    def test_wrong_action_order_fails(self):
        metrics = [metric() for _ in range(24)]
        metrics[5] = metric(yaw=0.24)
        metrics[6] = metric(yaw=0.25)
        metrics[14] = metric(blink=0.8)
        with self.assertRaisesRegex(ValueError, "wrong_action_order"):
            evaluate(metrics, ["BLINK", "TURN_LEFT"])

    def test_missing_final_center_fails(self):
        metrics = [metric() for _ in range(24)]
        metrics[5] = metric(blink=0.8)
        metrics[13] = metric(yaw=0.24)
        metrics[14] = metric(yaw=0.25)
        for index in range(15, 24):
            metrics[index] = metric(yaw=0.3)
        with self.assertRaises(ValueError):
            evaluate(metrics, ["BLINK", "TURN_LEFT"])


if __name__ == "__main__":
    unittest.main()

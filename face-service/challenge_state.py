from typing import Literal


FaceAction = Literal["BLINK", "TURN_LEFT", "TURN_RIGHT"]


def evaluate_action_sequence(
    metrics: list[dict],
    actions: list[FaceAction],
    *,
    center_yaw: float,
    turn_yaw: float,
    blink_open_score: float,
    blink_closed_score: float,
) -> tuple[list[dict], list[int]]:
    def is_center(metric: dict) -> bool:
        yaw = metric["yaw"]
        return yaw is not None and abs(yaw) <= center_yaw

    def detect_blink(cursor: int) -> dict | None:
        for peak in range(max(cursor + 1, 1), len(metrics) - 1):
            if metrics[peak]["blink"] < blink_closed_score:
                continue
            starts = [
                index
                for index in range(max(cursor, peak - 4), peak)
                if metrics[index]["blink"] <= blink_open_score
                and is_center(metrics[index])
            ]
            ends = [
                index
                for index in range(peak + 1, min(len(metrics), peak + 6))
                if metrics[index]["blink"] <= blink_open_score
                and is_center(metrics[index])
            ]
            if starts and ends:
                return {
                    "action": "BLINK",
                    "passed": True,
                    "startFrame": starts[-1],
                    "peakFrame": peak,
                    "endFrame": ends[0],
                }
        return None

    def detect_turn(cursor: int, action: FaceAction) -> dict | None:
        # Camera frames are not mirrored. Positive nose offset means user left.
        expected_sign = 1.0 if action == "TURN_LEFT" else -1.0
        for peak in range(max(cursor + 1, 1), len(metrics) - 2):
            yaw = metrics[peak]["yaw"]
            next_yaw = metrics[peak + 1]["yaw"]
            if yaw is None or next_yaw is None:
                continue
            if expected_sign * yaw < turn_yaw:
                continue
            if expected_sign * next_yaw < turn_yaw:
                continue
            starts = [
                index
                for index in range(max(cursor, peak - 5), peak)
                if is_center(metrics[index])
            ]
            ends = [
                index
                for index in range(peak + 2, min(len(metrics), peak + 8))
                if is_center(metrics[index])
            ]
            if starts and ends:
                return {
                    "action": action,
                    "passed": True,
                    "startFrame": starts[-1],
                    "peakFrame": peak,
                    "endFrame": ends[0],
                }
        return None

    initial = next(
        (index for index in range(min(5, len(metrics))) if is_center(metrics[index])),
        None,
    )
    if initial is None:
        raise ValueError("initial_pose_not_centered")

    cursor = initial
    results: list[dict] = []
    for action in actions:
        result = detect_blink(cursor) if action == "BLINK" else detect_turn(cursor, action)
        if result is None:
            raise ValueError("wrong_action_order")
        results.append(result)
        cursor = result["endFrame"]

    final_candidates = [
        index
        for index in range(max(cursor, len(metrics) - 5), len(metrics))
        if is_center(metrics[index])
    ]
    if not final_candidates:
        raise ValueError("final_pose_not_centered")

    representatives = [
        initial,
        results[0]["peakFrame"],
        results[0]["endFrame"],
        results[1]["peakFrame"],
        final_candidates[-1],
    ]
    return results, representatives

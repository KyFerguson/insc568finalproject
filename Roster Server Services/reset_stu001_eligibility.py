#!/usr/bin/env python3
"""Reset STU001 to an enrollment-eligible status for testing.

This script updates studentRoster.json so STU001 points to an academic status
whose statusType is admitted or enrolled, and removes any in-progress
enrollments for that student.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
DB_DIR = SCRIPT_DIR / "Roster Info DB"
STUDENT_ROSTER_PATH = DB_DIR / "studentRoster.json"
ACADEMIC_STATUS_PATH = DB_DIR / "academicStatus.json"
ENROLLMENTS_PATH = DB_DIR / "student_course_inprogress.json"
COURSE_SCHEDULE_PATH = SCRIPT_DIR.parent / "Course Registration DB" / "course_schedule.json"

TARGET_STUDENT_ID = "STU001"
ELIGIBLE_STATUS_TYPES = ("admitted", "enrolled")


def now_iso_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")


def choose_eligible_status_id(academic_statuses: list[dict]) -> str:
    for preferred in ELIGIBLE_STATUS_TYPES:
        for status in academic_statuses:
            status_type = str(status.get("statusType", "")).strip().lower()
            if status_type == preferred:
                return str(status.get("academicStatusID", "")).strip()

    return ""


def reset_enrollments_for_student(student_id: str, timestamp: str) -> tuple[int, int]:
    enrollments_data = load_json(ENROLLMENTS_PATH)
    schedules_data = load_json(COURSE_SCHEDULE_PATH)

    enrollments = enrollments_data.get("enrollments", [])
    schedules = schedules_data.get("courseSchedules", [])

    if not isinstance(enrollments, list) or not isinstance(schedules, list):
        raise RuntimeError("Unexpected JSON shape in enrollment files.")

    student_enrollments = [
        item for item in enrollments if str(item.get("studentId", "")).strip() == student_id
    ]

    schedule_ids = {
        str(item.get("courseScheduleId", "")).strip()
        for item in student_enrollments
        if str(item.get("courseScheduleId", "")).strip()
    }

    remaining_enrollments = [
        item for item in enrollments if str(item.get("studentId", "")).strip() != student_id
    ]
    enrollments_data["enrollments"] = remaining_enrollments

    schedules_updated = 0
    for schedule in schedules:
        schedule_id = str(schedule.get("courseScheduleID", "")).strip()
        if schedule_id not in schedule_ids:
            continue

        current_count = int(schedule.get("enrolledCount", 0) or 0)
        if current_count > 0:
            schedule["enrolledCount"] = current_count - 1

        capacity = int(schedule.get("capacity", 0) or 0)
        enrolled_count = int(schedule.get("enrolledCount", 0) or 0)
        schedule["availability"] = True if capacity <= 0 else enrolled_count < capacity
        schedule["updatedAt"] = timestamp
        schedules_updated += 1

    schedules_data["courseSchedules"] = schedules
    write_json(ENROLLMENTS_PATH, enrollments_data)
    write_json(COURSE_SCHEDULE_PATH, schedules_data)

    return len(student_enrollments), schedules_updated


def main() -> int:
    student_roster = load_json(STUDENT_ROSTER_PATH)
    academic_status_data = load_json(ACADEMIC_STATUS_PATH)

    students = student_roster.get("students", [])
    academic_statuses = academic_status_data.get("academicStatuses", [])

    if not isinstance(students, list) or not isinstance(academic_statuses, list):
        raise RuntimeError("Unexpected JSON shape in roster files.")

    student = next((item for item in students if str(item.get("stuId", "")).strip() == TARGET_STUDENT_ID), None)
    if not student:
        raise RuntimeError(f"Student {TARGET_STUDENT_ID} not found in {STUDENT_ROSTER_PATH.name}.")

    eligible_status_id = choose_eligible_status_id(academic_statuses)
    if not eligible_status_id:
        raise RuntimeError("No admitted or enrolled status found in academicStatus.json.")

    matching_status = next(
        (
            status
            for status in academic_statuses
            if str(status.get("academicStatusID", "")).strip() == eligible_status_id
        ),
        {},
    )

    timestamp = now_iso_utc()
    student["academicStatusID"] = eligible_status_id
    student["updatedAt"] = timestamp
    write_json(STUDENT_ROSTER_PATH, student_roster)

    removed_enrollment_count, updated_schedule_count = reset_enrollments_for_student(TARGET_STUDENT_ID, timestamp)

    status_type = str(matching_status.get("statusType", "unknown"))
    print(
        "Reset complete:",
        f"studentId={TARGET_STUDENT_ID}",
        f"academicStatusID={eligible_status_id}",
        f"statusType={status_type}",
        f"enrollmentsRemoved={removed_enrollment_count}",
        f"schedulesUpdated={updated_schedule_count}",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

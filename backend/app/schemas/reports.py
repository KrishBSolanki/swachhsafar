import uuid
from datetime import date

from pydantic import BaseModel


class JourneySummary(BaseModel):
    journey_id: uuid.UUID
    state: str
    staff_allocated: int
    attendance_records: int
    attendance_by_stage: dict[int, int]
    staff_fully_attended: int
    inspections_required: int
    inspections_done: int
    inspection_completion_pct: float | None
    passenger_feedback_counted: int
    passenger_feedback_completed: int
    passenger_feedback_pending: int
    passenger_feedback_void: int
    railway_feedback: int
    complaints_open: int
    complaints_overdue: int
    complaints_closed: int
    inventory_lines: int


class AttendanceRow(BaseModel):
    key_id: uuid.UUID
    label: str
    journeys: int
    records: int
    stages: dict[int, int]
    verified: int
    rejected: int


class InspectionRow(BaseModel):
    journey_id: uuid.UUID
    train_no: str
    journey_date: date
    coach_code: str | None
    required: int
    done: int
    completion_pct: float | None
    verified: int
    rejected: int


class QuestionAverage(BaseModel):
    question_id: uuid.UUID
    position: int
    text_en: str
    responses: int
    average: float | None


class FeedbackReport(BaseModel):
    audience: str
    bank_id: uuid.UUID | None
    scale_min: int | None
    scale_max: int | None
    total: int
    by_status: dict[str, int]
    by_coach_class: dict[str, int]
    questions: list[QuestionAverage]


class ComplaintReport(BaseModel):
    total: int
    by_status: dict[str, int]
    overdue: int
    by_category: list[dict]
    avg_resolution_hours: float | None


class InventoryRow(BaseModel):
    item_id: uuid.UUID
    item_name: str
    unit: str
    issued: float
    returned: float
    consumed: float
    journeys: int


class PsiRow(BaseModel):
    journey_id: uuid.UUID
    train_no: str
    journey_date: date
    responses: int
    psi: float | None


class DivisionDashboard(BaseModel):
    division_id: uuid.UUID
    date: date
    journeys_active: int
    journeys_scheduled: int
    attendance_today: int
    inspections_today: int
    passenger_feedback_today: int
    railway_feedback_today: int
    complaints_open: int
    complaints_overdue: int

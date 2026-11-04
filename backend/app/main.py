from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.v1 import complaints, feedback, inventory, journeys, media, operations, org, reports, sync, trains
from app.config import get_settings
from app.db import WriteIntentMiddleware, get_engine
from app.errors import install_error_handlers


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Swachh Safar Operations API",
        version="2.0.0",
        docs_url=None if settings.environment == "production" else "/docs",
        openapi_url="/api/v1/openapi.json",
    )
    install_error_handlers(app)
    app.add_middleware(WriteIntentMiddleware)  # SQLite: write requests take the write lock up front
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
            expose_headers=["Idempotent-Replayed"],
        )

    v1 = APIRouter(prefix="/api/v1")
    for router in (
        org.auth_router, org.users_router, org.roles_router, org.divisions_router, org.permissions_router, org.audit_router,
        trains.router, trains.coaches_router, journeys.router, journeys.staff_router,
        operations.attendance_router, operations.inspections_router, feedback.router, complaints.router,
        inventory.router, reports.router, reports.dashboard_router, sync.router, media.router,
    ):
        v1.include_router(router)
    app.include_router(v1)

    @app.get("/health", tags=["health"])
    def health():
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"status": "ok"}

    return app


app = create_app()

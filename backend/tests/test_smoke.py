def test_health_and_world(client, world):
    assert client.get("/health").json() == {"status": "ok"}
    r = client.get("/api/v1/auth/me", headers=world.h("sup"))
    assert r.status_code == 200
    me = r.json()
    assert me["user"]["role_id"] == 4
    assert "attendance.submit" in me["divisions"][str(world.a.id)]
    assert world.journey["state"] == "active"

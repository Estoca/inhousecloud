# Minimal Web App

Runnable example app for Open Company Cloud.

## Run

```bash
cp .env.example .env
docker compose up --build
```

Check:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/me
```


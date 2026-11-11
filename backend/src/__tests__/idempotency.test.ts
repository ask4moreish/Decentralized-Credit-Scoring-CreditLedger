import express from 'express';
import request from 'supertest';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { resetTestMemoryDb } from '../services/dbService';
import { disconnectDatabase } from '../config/database';

describe('Idempotency-Key Middleware', () => {
  const app = express();
  app.use(express.json());

  let counter = 0;
  app.post('/op', idempotencyMiddleware, (req, res) => {
    counter += 1;
    res.status(201).json({ count: counter, payload: req.body });
  });

  beforeEach(() => {
    counter = 0;
    resetTestMemoryDb();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  test('executes once on first request and replays cached response cleanly on retry', async () => {
    const key = 'idem-key-replay-001';
    const first = await request(app)
      .post('/op')
      .set('Idempotency-Key', key)
      .send({ amount: '100' });

    expect(first.status).toBe(201);
    expect(first.body.count).toBe(1);

    const retry = await request(app)
      .post('/op')
      .set('Idempotency-Key', key)
      .send({ amount: '100' });

    expect(retry.status).toBe(201);
    expect(retry.headers['x-idempotent-replay']).toBe('true');
    expect(retry.body.count).toBe(1);
    expect(counter).toBe(1);
  });

  test('returns 409 Conflict if the same Idempotency-Key is reused with a different payload', async () => {
    const key = 'idem-key-conflict-002';
    const first = await request(app)
      .post('/op')
      .set('Idempotency-Key', key)
      .send({ amount: '100' });
    expect(first.status).toBe(201);

    const conflict = await request(app)
      .post('/op')
      .set('Idempotency-Key', key)
      .send({ amount: '250' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/conflict/i);
  });

  test('rejects keys longer than 128 characters', async () => {
    const res = await request(app)
      .post('/op')
      .set('Idempotency-Key', 'x'.repeat(129))
      .send({ amount: '10' });
    expect(res.status).toBe(400);
  });
});

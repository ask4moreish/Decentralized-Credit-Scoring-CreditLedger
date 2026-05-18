import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../middleware/auth';

const app = express();
app.use(express.json());
app.get('/protected', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

const SECRET = 'secret';

describe('authMiddleware', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer badtoken');
    expect(res.status).toBe(401);
  });

  it('passes through with a valid JWT', async () => {
    const token = jwt.sign({ publicKey: 'GABC', isAdmin: false }, SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.publicKey).toBe('GABC');
  });

  it('returns 401 for expired token', async () => {
    const token = jwt.sign({ publicKey: 'GABC', isAdmin: false }, SECRET, { expiresIn: '-1s' });
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

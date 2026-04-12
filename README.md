# CreditLedger - Decentralized Credit Scoring System

CreditLedger is a Web3 application that builds on-chain credit scores from alternative data sources, enabling access to DeFi loans without traditional banking history. Built on the Stellar blockchain for fast, low-cost transactions.

## Features

- **Decentralized Credit Scoring**: Build credit scores using mobile payments, savings behavior, and community vouching
- **Collateral-Free Loans**: Access DeFi loans based on your on-chain credit reputation
- **Community Vouching**: Get vouched by trusted community members to boost your credit score
- **Stellar Blockchain**: Fast, low-cost transactions for global accessibility
- **Privacy-Preserving**: Zero-knowledge proofs for sensitive data verification
- **Real-Time Analytics**: Track your credit score trends and financial health

## Architecture

### Smart Contracts (Stellar Soroban)
- **CreditScore**: Main credit scoring algorithm and data management
- **LoanManager**: Loan origination, management, and repayment
- **CommunityVouch**: Community vouching system and trust networks

### Backend Services
- **Node.js/Express**: RESTful API with PostgreSQL database
- **Redis**: Caching layer for performance
- **Stellar SDK**: Blockchain integration
- **JWT Authentication**: Secure user sessions

### Frontend Application
- **React 18**: Modern UI with TypeScript
- **Tailwind CSS**: Responsive design system
- **Zustand**: State management
- **React Query**: Data fetching and caching
- **Freighter Integration**: Stellar wallet connection

## Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- Stellar Freighter wallet extension

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/your-username/credit-ledger.git
cd credit-ledger
```

2. **Environment Setup**
```bash
# Copy environment files
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# Set your environment variables
# See Environment Variables section below
```

3. **Start with Docker**
```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f
```

4. **Access the Application**
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001
- PostgreSQL: localhost:5432
- Redis: localhost:6379
- Stellar Horizon: http://localhost:8000

### Manual Setup

#### Backend Setup
```bash
cd backend
npm install
npm run build
npm run dev
```

#### Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

#### Smart Contracts
```bash
cd contracts
cargo build
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/credit_ledger.wasm --network testnet
```

## Environment Variables

### Backend (.env)
```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres123
DB_NAME=credit_ledger

# Redis
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_ADMIN_SECRET=your_admin_secret_key
CREDIT_SCORE_CONTRACT=contract_address_here
LOAN_MANAGER_CONTRACT=contract_address_here
COMMUNITY_VOUCH_CONTRACT=contract_address_here

# Security
JWT_SECRET=your_super_secret_jwt_key
FRONTEND_URL=http://localhost:3000

# Development
NODE_ENV=development
LOG_LEVEL=info
```

### Frontend (.env)
```env
VITE_API_URL=http://localhost:3001
VITE_STELLAR_NETWORK=testnet
VITE_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
```

## Smart Contract Deployment

### 1. Build Contracts
```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

### 2. Deploy to Testnet
```bash
# Deploy Credit Score contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/credit_score.wasm \
  --source admin_account \
  --network testnet

# Deploy Loan Manager contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/loan_manager.wasm \
  --source admin_account \
  --network testnet

# Deploy Community Vouch contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/community_vouch.wasm \
  --source admin_account \
  --network testnet
```

### 3. Initialize Contracts
```bash
# Initialize Credit Score contract
soroban contract invoke \
  --id CREDIT_SCORE_CONTRACT_ID \
  --source admin_account \
  --network testnet \
  -- initialize \
  --admin admin_account_address

# Initialize Loan Manager contract
soroban contract invoke \
  --id LOAN_MANAGER_CONTRACT_ID \
  --source admin_account \
  --network testnet \
  -- initialize \
  --admin admin_account_address \
  --credit_score_contract CREDIT_SCORE_CONTRACT_ID
```

## API Documentation

### Authentication
All protected endpoints require a valid JWT token obtained from wallet connection.

### Credit Score Endpoints
```
POST /api/credit-score/payment-history    # Update payment history
POST /api/credit-score/savings-data       # Update savings data
GET  /api/credit-score/:userPublicKey     # Get credit score
GET  /api/credit-score/:userPublicKey/breakdown # Get score breakdown
```

### Loan Endpoints
```
POST /api/loans/apply                     # Apply for loan
GET  /api/loans/:loanId                   # Get loan details
POST /api/loans/:loanId/repay             # Repay loan
GET  /api/loans/user/:userPublicKey       # Get user loans
```

### Vouching Endpoints
```
POST /api/vouch/create                    # Create vouch
POST /api/vouch/:vouchId/revoke           # Revoke vouch
GET  /api/vouch/user/:userPublicKey       # Get user vouches
```

## Credit Scoring Algorithm

The credit score is calculated using a weighted algorithm:

- **Payment History (40%)**: Mobile payment consistency and frequency
- **Savings Behavior (30%)**: Regular savings patterns and duration
- **Community Trust (20%)**: Vouching from trusted community members
- **Platform Activity (10%)**: Usage and engagement metrics

### Score Ranges
- **800-1000**: Excellent - 5% interest rate
- **700-799**: Good - 8% interest rate
- **600-699**: Fair - 12% interest rate
- **500-599**: Poor - 18% interest rate
- **Below 500**: Very Poor - 25% interest rate

## Testing

### Backend Tests
```bash
cd backend
npm test
npm run test:watch
npm run test:coverage
```

### Frontend Tests
```bash
cd frontend
npm test
npm run test:ui
npm run test:coverage
```

### Smart Contract Tests
```bash
cd contracts
cargo test
```

## Deployment

### Production Deployment
```bash
# Build and deploy all services
docker-compose -f docker-compose.prod.yml up -d

# Or deploy individually
# Backend
cd backend
docker build -t credit-ledger-backend .
docker push your-registry/credit-ledger-backend

# Frontend
cd frontend
docker build -t credit-ledger-frontend .
docker push your-registry/credit-ledger-frontend
```

### Environment Setup
- **Staging**: Use Stellar testnet
- **Production**: Use Stellar mainnet
- Configure proper SSL certificates
- Set up monitoring and logging
- Configure backup strategies

## Security Considerations

- **Private Keys**: Never commit private keys to version control
- **Environment Variables**: Use secure secret management in production
- **Input Validation**: All user inputs are validated and sanitized
- **Rate Limiting**: API endpoints are rate-limited to prevent abuse
- **Audit Trail**: All transactions are logged on-chain

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Follow the existing code style
- Write tests for new features
- Update documentation as needed
- Ensure all tests pass before submitting

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Documentation**: [docs.creditledger.io](https://docs.creditledger.io)
- **Discord**: [Join our community](https://discord.gg/creditledger)
- **Twitter**: [@CreditLedger](https://twitter.com/CreditLedger)
- **Email**: support@creditledger.io

## Roadmap

### Phase 1: Core Features (Q1 2024)
- [x] Basic credit scoring
- [x] Simple loan system
- [x] Community vouching
- [x] Web interface

### Phase 2: Advanced Features (Q2 2024)
- [ ] Mobile app
- [ ] Advanced analytics
- [ ] Multi-currency support
- [ ] Insurance products

### Phase 3: Ecosystem (Q3 2024)
- [ ] DeFi integrations
- [ ] API for third parties
- [ ] Governance token
- [ ] DAO structure

### Phase 4: Scaling (Q4 2024)
- [ ] Layer 2 solutions
- [ ] Cross-chain support
- [ ] Enterprise features
- [ ] Global expansion

---

**Built with love for the unbanked and underbanked worldwide**

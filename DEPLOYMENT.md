# CreditLedger Deployment Guide

This guide covers deploying CreditLedger to various environments including development, staging, and production.

## Table of Contents
- [Development Setup](#development-setup)
- [Staging Deployment](#staging-deployment)
- [Production Deployment](#production-deployment)
- [Smart Contract Deployment](#smart-contract-deployment)
- [Infrastructure Setup](#infrastructure-setup)
- [Monitoring & Logging](#monitoring--logging)
- [Security Considerations](#security-considerations)

## Development Setup

### Local Development with Docker

1. **Prerequisites**
   - Docker Desktop
   - Git
   - Node.js 18+ (for local development)

2. **Setup**
```bash
# Clone repository
git clone https://github.com/your-org/credit-ledger.git
cd credit-ledger

# Copy environment files
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# Start services
docker-compose up -d

# View logs
docker-compose logs -f
```

3. **Access Services**
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001
- PostgreSQL: localhost:5432
- Redis: localhost:6379
- Stellar Horizon: http://localhost:8000

### Manual Development Setup

#### Backend
```bash
cd backend
npm install
npm run build
npm run dev
```

#### Frontend
```bash
cd frontend
npm install
npm run dev
```

#### Smart Contracts
```bash
cd contracts
cargo build
cargo test
```

## Staging Deployment

### AWS Infrastructure

1. **VPC and Networking**
```bash
# Create VPC
aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=credit-ledger-staging}]'

# Create subnets
aws ec2 create-subnet --vpc-id vpc-xxx --cidr-block 10.0.1.0/24 --availability-zone us-east-1a
aws ec2 create-subnet --vpc-id vpc-xxx --cidr-block 10.0.2.0/24 --availability-zone us-east-1b
```

2. **RDS PostgreSQL**
```bash
aws rds create-db-instance \
  --db-instance-identifier credit-ledger-staging-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --master-username postgres \
  --master-user-password your-secure-password \
  --allocated-storage 20 \
  --vpc-security-group-ids sg-xxx
```

3. **ElastiCache Redis**
```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id credit-ledger-staging-redis \
  --cache-node-type cache.t3.micro \
  --engine redis \
  --num-cache-nodes 1 \
  --security-group-ids sg-xxx
```

4. **ECS Cluster**
```bash
aws ecs create-cluster --cluster-name credit-ledger-staging
```

### Kubernetes Deployment

1. **Create Namespace**
```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: credit-ledger-staging
```

2. **Deploy Backend**
```yaml
# backend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: credit-ledger-backend
  namespace: credit-ledger-staging
spec:
  replicas: 2
  selector:
    matchLabels:
      app: credit-ledger-backend
  template:
    metadata:
      labels:
        app: credit-ledger-backend
    spec:
      containers:
      - name: backend
        image: your-registry/credit-ledger-backend:staging
        ports:
        - containerPort: 3001
        env:
        - name: NODE_ENV
          value: "staging"
        - name: DB_HOST
          value: "your-rds-endpoint"
        - name: REDIS_URL
          value: "your-redis-endpoint"
```

3. **Deploy Frontend**
```yaml
# frontend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: credit-ledger-frontend
  namespace: credit-ledger-staging
spec:
  replicas: 2
  selector:
    matchLabels:
      app: credit-ledger-frontend
  template:
    metadata:
      labels:
        app: credit-ledger-frontend
    spec:
      containers:
      - name: frontend
        image: your-registry/credit-ledger-frontend:staging
        ports:
        - containerPort: 80
```

## Production Deployment

### AWS Production Setup

1. **High Availability Database**
```bash
aws rds create-db-instance \
  --db-instance-identifier credit-ledger-prod-db \
  --db-instance-class db.r5.large \
  --engine postgres \
  --master-username postgres \
  --master-user-password production-password \
  --allocated-storage 100 \
  --multi-az \
  --backup-retention-period 30 \
  --storage-type gp2
```

2. **ElastiCache Cluster**
```bash
aws elasticache create-replication-group \
  --replication-group-id credit-ledger-prod-redis \
  --replication-group-description "Production Redis cluster" \
  --num-cache-clusters 3 \
  --cache-node-type cache.r5.large \
  --engine redis \
  --automatic-failover-enabled
```

3. **Application Load Balancer**
```bash
aws elbv2 create-load-balancer \
  --name credit-ledger-prod-alb \
  --subnets subnet-xxx subnet-yyy \
  --security-groups sg-xxx \
  --scheme internet-facing \
  --type application
```

### CI/CD Pipeline

#### GitHub Actions Workflow
```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run tests
        run: |
          cd backend && npm test
          cd ../frontend && npm test
          cd ../contracts && cargo test

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build and push backend
        uses: docker/build-push-action@v3
        with:
          context: ./backend
          push: true
          tags: your-registry/credit-ledger-backend:${{ github.sha }}
      
      - name: Build and push frontend
        uses: docker/build-push-action@v3
        with:
          context: ./frontend
          push: true
          tags: your-registry/credit-ledger-frontend:${{ github.sha }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to production
        run: |
          # Update Kubernetes deployments
          kubectl set image deployment/credit-ledger-backend backend=your-registry/credit-ledger-backend:${{ github.sha }}
          kubectl set image deployment/credit-ledger-frontend frontend=your-registry/credit-ledger-frontend:${{ github.sha }}
```

## Smart Contract Deployment

### Testnet Deployment
```bash
# Build contracts
cd contracts
cargo build --target wasm32-unknown-unknown --release

# Deploy to testnet
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/credit_score.wasm \
  --source SA... \
  --network testnet

# Initialize contracts
soroban contract invoke \
  --id CONTRACT_ID \
  --source SA... \
  --network testnet \
  -- initialize \
  --admin ADMIN_ADDRESS
```

### Mainnet Deployment
```bash
# Deploy to mainnet (requires careful testing)
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/credit_score.wasm \
  --source MAIN_ADMIN_ACCOUNT \
  --network public

# Verify deployment
soroban contract read \
  --id CONTRACT_ID \
  --network public \
  --key admin
```

### Contract Upgrade Process
```bash
# Deploy new version
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/credit_score_v2.wasm \
  --source ADMIN_ACCOUNT \
  --network public

# Migrate data (if needed)
soroban contract invoke \
  --id NEW_CONTRACT_ID \
  --source ADMIN_ACCOUNT \
  --network public \
  -- migrate_from OLD_CONTRACT_ID
```

## Infrastructure Setup

### Terraform Configuration

```hcl
# main.tf
provider "aws" {
  region = var.aws_region
}

# VPC
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "credit-ledger-vpc"
  }
}

# RDS
resource "aws_db_instance" "postgres" {
  identifier     = "credit-ledger-db"
  engine         = "postgres"
  engine_version = "14.9"
  instance_class = "db.r5.large"
  
  allocated_storage     = 100
  max_allocated_storage = 1000
  storage_type          = "gp2"
  storage_encrypted     = true
  
  db_name  = "credit_ledger"
  username = var.db_username
  password = var.db_password
  
  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.main.name
  
  backup_retention_period = 30
  backup_window          = "03:00-04:00"
  maintenance_window    = "sun:04:00-sun:05:00"
  
  skip_final_snapshot = false
  final_snapshot_identifier = "credit-ledger-final-snapshot"
  
  tags = {
    Name = "credit-ledger-db"
  }
}

# ElastiCache
resource "aws_elasticache_subnet_group" "main" {
  name       = "credit-ledger-cache-subnet"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "credit-ledger-redis"
  engine               = "redis"
  node_type            = "cache.r5.large"
  num_cache_nodes      = 3
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
  
  tags = {
    Name = "credit-ledger-redis"
  }
}
```

## Monitoring & Logging

### CloudWatch Setup
```yaml
# cloudwatch-config.yml
Resources:
  CreditLedgerLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /aws/ecs/credit-ledger
      RetentionInDays: 30

  CreditLedgerAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: CreditLedgerHighErrorRate
      AlarmDescription: High error rate detected
      MetricName: ErrorCount
      Namespace: CreditLedger
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 2
      Threshold: 10
      ComparisonOperator: GreaterThanThreshold
      AlarmActions:
        - arn:aws:sns:us-east-1:123456789012:CreditLedgerAlerts
```

### Prometheus Monitoring
```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'credit-ledger-backend'
    static_configs:
      - targets: ['backend:3001']
    metrics_path: '/metrics'
    
  - job_name: 'credit-ledger-frontend'
    static_configs:
      - targets: ['frontend:80']
    metrics_path: '/metrics'
```

### Grafana Dashboards
- Application performance metrics
- Database performance
- Redis cache metrics
- Smart contract interactions
- User activity analytics

## Security Considerations

### Network Security
```yaml
# security-groups.yml
Resources:
  BackendSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Security group for backend services
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 3001
          ToPort: 3001
          SourceSecurityGroupId: !Ref ALBSecurityGroup
      SecurityGroupEgress:
        - IpProtocol: -1
          CidrIp: 0.0.0.0/0

  DatabaseSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Security group for RDS
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 5432
          ToPort: 5432
          SourceSecurityGroupId: !Ref BackendSecurityGroup
```

### Secrets Management
```bash
# AWS Secrets Manager
aws secretsmanager create-secret \
  --name credit-ledger/db-credentials \
  --secret-string '{"username":"postgres","password":"secure-password"}'

aws secretsmanager create-secret \
  --name credit-ledger/jwt-secret \
  --secret-string '{"secret":"your-jwt-secret"}'

aws secretsmanager create-secret \
  --name credit-ledger/stellar-keys \
  --secret-string '{"admin_secret":"your-stellar-admin-secret"}'
```

### SSL/TLS Configuration
```yaml
# certificate-manager.yml
Resources:
  Certificate:
    Type: AWS::CertificateManager::Certificate
    Properties:
      DomainName: api.creditledger.io
      ValidationMethod: DNS
      SubjectAlternativeNames:
        - creditledger.io
        - www.creditledger.io
```

## Disaster Recovery

### Backup Strategy
1. **Database Backups**: Automated daily snapshots with 30-day retention
2. **Redis Backups**: Daily snapshots with 7-day retention
3. **File Backups**: S3 with versioning enabled
4. **State Backups**: Smart contract state regularly backed up

### Recovery Procedures
```bash
# Database recovery
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier credit-ledger-restored \
  --db-snapshot-identifier credit-ledger-snapshot

# Redis recovery
aws elasticache create-replication-group \
  --replication-group-id credit-ledger-restored \
  --snapshot-name credit-ledger-snapshot
```

## Performance Optimization

### Database Optimization
- Read replicas for read-heavy operations
- Connection pooling
- Query optimization
- Indexing strategy

### Caching Strategy
- Redis for frequently accessed data
- CDN for static assets
- Browser caching headers
- API response caching

### Auto Scaling
```yaml
# auto-scaling.yml
Resources:
  BackendAutoScalingGroup:
    Type: AWS::AutoScaling::AutoScalingGroup
    Properties:
      VPCZoneIdentifier: [!Ref PrivateSubnet1, !Ref PrivateSubnet2]
      LaunchConfigurationName: !Ref BackendLaunchConfig
      MinSize: 2
      MaxSize: 10
      DesiredCapacity: 4
      TargetGroupARNs:
        - !Ref BackendTargetGroup
```

This deployment guide provides comprehensive instructions for deploying CreditLedger across different environments with proper security, monitoring, and disaster recovery measures.

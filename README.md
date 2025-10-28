# Influencer CRM Backend

Backend API for the Influencer CRM system built with Node.js, Express, TypeScript, and Prisma.

## Features

- **Authentication & Authorization**: JWT-based auth with role-based access control
- **Full CRUD Operations**: Complete REST API for all entities
- **Type Safety**: Full TypeScript implementation with strict type checking
- **Database**: PostgreSQL with Prisma ORM
- **Email Automation**: Template-based email system with variable replacement
- **Audit Logging**: Comprehensive activity tracking
- **Pipeline Management**: Two-stage influencer pipeline (Outreach → Contract)

## Tech Stack

- Node.js & Express.js
- TypeScript
- Prisma ORM
- PostgreSQL
- JWT Authentication
- Nodemailer (Gmail integration)
- Google APIs

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: Secret key for JWT tokens
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`: For Gmail OAuth
- `FRONTEND_URL`: Frontend application URL for CORS

### 3. Database Setup

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# (Optional) Open Prisma Studio
npm run prisma:studio
```

### 4. Start Development Server

```bash
npm run dev
```

The server will start on `http://localhost:5000`

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/profile` - Get user profile
- `PUT /api/auth/profile` - Update user profile

### Influencers
- `GET /api/influencers` - List influencers (with pagination, search, filters)
- `GET /api/influencers/:id` - Get influencer details
- `POST /api/influencers` - Create influencer
- `PUT /api/influencers/:id` - Update influencer
- `DELETE /api/influencers/:id` - Delete influencer
- `POST /api/influencers/bulk/update-status` - Bulk update status
- `POST /api/influencers/import` - Import from Excel

### Contracts
- `GET /api/contracts` - List contracts
- `GET /api/contracts/:id` - Get contract details
- `POST /api/contracts` - Create contract
- `PUT /api/contracts/:id` - Update contract
- `DELETE /api/contracts/:id` - Delete contract

### Campaigns
- `GET /api/campaigns` - List campaigns
- `GET /api/campaigns/:id` - Get campaign details
- `POST /api/campaigns` - Create campaign
- `PUT /api/campaigns/:id` - Update campaign
- `DELETE /api/campaigns/:id` - Delete campaign
- `POST /api/campaigns/:id/influencers` - Add influencer to campaign
- `DELETE /api/campaigns/:id/influencers/:influencerId` - Remove influencer

### Email Templates
- `GET /api/email-templates` - List templates
- `GET /api/email-templates/:id` - Get template
- `POST /api/email-templates` - Create template
- `PUT /api/email-templates/:id` - Update template
- `DELETE /api/email-templates/:id` - Delete template

### Emails
- `GET /api/emails` - List sent emails
- `POST /api/emails/send` - Send single email
- `POST /api/emails/bulk-send` - Bulk send emails

### Dashboard
- `GET /api/dashboard/stats` - Get dashboard statistics
- `GET /api/dashboard/pipeline` - Get pipeline data
- `GET /api/dashboard/activity` - Get recent activity

## Database Schema

### Main Entities
- **User**: System users with role-based access
- **Influencer**: Influencer profiles with contact info and status
- **Contract**: Contract management with influencers
- **Campaign**: Marketing campaigns
- **EmailTemplate**: Reusable email templates
- **Email**: Email history and tracking
- **AuditLog**: Activity audit trail

### Enums
- **UserRole**: ADMIN, MANAGER, MEMBER
- **InfluencerStatus**: PING_1, PING_2, PING_3, CONTRACT, REJECTED, COMPLETED
- **ContractStatus**: DRAFT, SENT, SIGNED, ACTIVE, COMPLETED, CANCELLED
- **EmailStatus**: PENDING, SENT, FAILED, OPENED, REPLIED

## Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run prisma:generate` - Generate Prisma client
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio

## Security Features

- JWT-based authentication
- Password hashing with bcrypt
- Role-based access control
- Audit logging for all operations
- CORS configuration
- Input validation
- SQL injection protection (Prisma)

## Type Safety

All code is written in TypeScript with strict type checking enabled:
- No `any` types used
- Strict null checks
- Full type inference
- Type-safe database queries with Prisma


# K·Network Backend API v2.0

Node.js/Express backend for the IIMK Alumni Platform.

## Stack
- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: Supabase (PostgreSQL + Auth + Realtime)
- **WhatsApp**: authkey.io
- **LinkedIn sync**: Proxycurl
- **AI**: Anthropic Claude (moderation, K-Match explanations, achievement posts)
- **Payments**: Razorpay
- **E-sign**: Leegality
- **Deploy**: Railway

---

## API Routes

### Auth
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/send-otp` | Send WhatsApp OTP |
| POST | `/api/auth/verify-otp` | Verify OTP → session |
| POST | `/api/auth/register` | Create alumni profile |
| GET  | `/api/auth/me` | Get own profile |

### Alumni
| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/api/alumni` | Directory with search/filter |
| GET  | `/api/alumni/:id` | Single profile |
| PATCH | `/api/alumni/me` | Update own profile |
| POST | `/api/alumni/me/sync-linkedin` | Trigger Proxycurl sync |
| GET  | `/api/alumni/me/events` | Events attended + people met |
| POST | `/api/alumni/connections` | Send connection request |
| PATCH | `/api/alumni/connections/:id` | Accept/decline request |
| POST | `/api/alumni/warm-intro` | Request A→B intro via C |
| GET  | `/api/alumni/me/connections` | My connections |
| GET  | `/api/alumni/directory/companies` | Alumni company directory |

### K-Match
| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/api/kmatch/feed` | Personalised match suggestions |
| POST | `/api/kmatch/action` | Swipe connect/skip |

### Events
| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/api/events` | All events with RSVP status |
| GET  | `/api/events/:id` | Single event + attendees |
| POST | `/api/events/:id/checkin` | **Self check-in** → people you met |
| POST | `/api/events/:id/rsvp` | RSVP to event |
| GET  | `/api/events/:id/attendees` | Full attendee list |
| POST | `/api/events` | Create event (admin) |
| PATCH | `/api/events/:id/publish` | Publish + WA notify (admin) |

### Feed
| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/api/feed` | Community feed |
| POST | `/api/feed` | Create post (AI moderated) |
| POST | `/api/feed/:id/like` | Like/unlike |
| DELETE | `/api/feed/:id` | Remove post |

### Opportunities
| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/api/opps` | All opportunities |
| POST | `/api/opps` | Post opportunity + WA notify |
| POST | `/api/opps/:id/interest` | Express interest |

### Syndicate
| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/api/syndicate/deals` | All active deals |
| POST | `/api/syndicate/participate` | Commit to deal |

### Other
| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/api/groups` | Interest groups |
| POST | `/api/groups/:id/join` | Join group |
| DELETE | `/api/groups/:id/leave` | Leave group |
| GET  | `/api/leaderboard` | Referral leaderboard |
| POST | `/api/broadcast` | WA broadcast (admin) |

### Webhooks
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/webhooks/razorpay` | Payment confirmation |
| POST | `/webhooks/leegality` | E-sign completion |

### Health
| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/health` | Service + DB status |

---

## Cron Jobs

| Schedule | Job |
|----------|-----|
| 1st of month, 3 AM IST | Monthly Proxycurl LinkedIn sync for all alumni |
| Daily 4 AM IST | Achievement detection (promotion/funding alerts) |
| Daily 2 AM IST | K-Match score recomputation for all alumni pairs |
| Daily 9 AM IST | Event reminders (30d, 7d, 1d before) |
| Sundays 8 AM IST | Weekly digest (email) |
| Daily midnight IST | Expired opportunities cleanup |

---

## Deployment on Railway

### 1. Push code
```bash
cd knetwork-backend
git init && git add . && git commit -m "K·Network backend v2"
```

### 2. Create Railway project
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### 3. Set environment variables in Railway dashboard
Copy all keys from `.env.template` and fill in real values.

**Required for launch:**
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
- `AUTHKEY_API_KEY` + `AUTHKEY_MOBILE`
- `JWT_SECRET` (generate: `openssl rand -base64 64`)
- `FRONTEND_URL`

**Required for full features:**
- `ANTHROPIC_API_KEY` (feed moderation, K-Match, achievements)
- `PROXYCURL_API_KEY` (LinkedIn sync)
- `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` (payments)
- `LEEGALITY_API_KEY` (e-sign)

### 4. Run Supabase schema
Open Supabase SQL Editor → paste `knetwork-schema.sql` → Run.

### 5. Set Razorpay + Leegality webhooks
- Razorpay Dashboard → Webhooks → `https://your-railway-url.up.railway.app/webhooks/razorpay`
- Leegality → Integrations → `https://your-railway-url.up.railway.app/webhooks/leegality`

### 6. Create authkey.io WA templates
Templates needed (names match `.env.template` WA_TPL_* vars):
- `welcome_v1` — welcome message on registration
- `otp_v1` — OTP verification
- `kmatch_alert_v1` — new K-Match connection request
- `opp_match_v1` — opportunity match alert
- `event_reminder_v1` — event reminder (30d/7d/1d)
- `syndicate_new_v1` — new syndicate deal
- `people_you_met_v1` — post event check-in
- `milestone_alert_v1` — achievement/promotion alert
- `warm_intro_request_v1` — warm intro request
- `collab_interest_v1` — collaboration interest

### 7. Wire frontend
Replace mock data calls in `knetwork-v4.html` with:
```javascript
const API = 'https://your-railway-url.up.railway.app/api';

// Example: load events
const { events } = await fetch(`${API}/events`, {
  headers: { Authorization: `Bearer ${token}` }
}).then(r => r.json());
```

---

## Security notes
- All routes except `/health`, `/webhooks/*`, `/api/auth/send-otp`, `/api/auth/verify-otp` require auth
- Chapter admins are city-scoped (middleware enforces this)
- OTP endpoint rate-limited to 3/minute
- Feed posts are Claude-moderated before publish
- K-Match and Syndicate require verified profile

---

## File structure
```
knetwork-backend/
├── server.js               ← Entry point
├── railway.toml            ← Railway deploy config
├── .env.template           ← All env vars documented
├── config/
│   ├── supabase.js         ← Supabase client
│   └── logger.js           ← Winston logger
├── middleware/
│   ├── auth.js             ← JWT + role checks
│   └── validate.js         ← Joi schemas for all routes
├── services/
│   ├── whatsapp.js         ← authkey.io — all 10 WA templates
│   ├── proxycurl.js        ← LinkedIn sync + milestone detection
│   └── claude.js           ← Moderation, K-Match, achievements
├── routes/
│   ├── auth.js             ← OTP, register, /me
│   ├── alumni.js           ← Directory, connections, warm intro, companies
│   ├── kmatch.js           ← Feed, swipe actions
│   ├── events.js           ← Events, RSVP, self check-in, people-you-met
│   └── feed.js             ← Feed, opps, syndicate, groups, leaderboard, broadcast
└── cron/
    └── index.js            ← 6 scheduled jobs
```

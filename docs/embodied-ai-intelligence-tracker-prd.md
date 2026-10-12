# Embodied AI Intelligence Tracker

> Real-time intelligence for robotics, models, companies, and real-world embodied AI data.

---

# 1. Product Overview

## 1.1 Product Name

**Embodied AI Intelligence Tracker**

Optional subtitle:

> **We don't just track robots. We track how robots learn.**

Chinese description:

> 一个专门追踪全球具身智能公司、机器人、模型、数据采集、部署、量产和技术演进的实时情报系统。

---

# 2. Product Goal

The product should not look like a traditional news website.

The core interaction should be:

```text
Open App
   ↓
See Latest Timeline
   ↓
Scroll Through Events
   ↓
Tap One Event
   ↓
Read Structured Detail
   ↓
Navigate to Company / Robot / Technology
```

The homepage should feel like a combination of:

- Timeline
- Milestone log
- Intelligence feed
- Technical changelog
- Company activity tracker

The product should be **mobile-first**.

Primary target screen:

```text
390px × 844px
```

Desktop version may center the mobile-width content inside a wider page.

---

# 3. Core Product Principle

This is not:

```text
News → Article
```

This is:

```text
Source
  ↓
Event
  ↓
Structured Intelligence
  ↓
Timeline
  ↓
Company / Robot / Technology Knowledge Base
```

Every event should be structured.

Example:

```json
{
  "company": "Tesla",
  "robot": "Optimus",
  "category": "DATA",
  "title": "New teleoperation training footage released",
  "date": "2026-09-27",
  "source_type": "PRIMARY",
  "confidence": "CONFIRMED"
}
```

---

# 4. Main User Experience

## 4.1 Main Navigation

For MVP, keep navigation extremely simple.

Bottom navigation on mobile:

```text
Timeline | Companies | Robots | Search
```

Recommended MVP:

- Timeline
- Companies
- Search

Robot navigation can be added later.

---

# 5. Homepage

## 5.1 Homepage Goal

The homepage is the core of the system.

It should answer:

> What changed in embodied AI recently?

The page should contain **one continuous vertical timeline**.

---

# 6. Homepage Layout

Mobile-first layout:

```text
┌──────────────────────────────┐
│ Embodied AI                  │
│ Intelligence Tracker         │
│                              │
│ [Search]        [Filter]     │
├──────────────────────────────┤
│                              │
│ September 27, 2026           │
│                              │
│ ● 09:42                      │
│ │ Tesla Optimus              │
│ │ DATA                       │
│ │                            │
│ │ New teleoperation          │
│ │ training footage released  │
│ │                            │
│ │ Confirmed · Primary Source │
│ │                            │
│ ● 08:55                      │
│ │ Figure                     │
│ │ DEPLOYMENT                 │
│ │                            │
│ │ New factory deployment     │
│ │ update                     │
│ │                            │
│ ● Yesterday                  │
│ │ Physical Intelligence      │
│ │ MODEL                      │
│ │                            │
│ │ New manipulation model     │
│ │ released                   │
│                              │
└──────────────────────────────┘
```

---

# 7. Timeline Design

## 7.1 Timeline Style

Use **one vertical line**.

Example:

```text
      09:42
        ●──────── Tesla Optimus
        │         DATA
        │         New teleoperation training footage
        │
      08:55
        ●──────── Figure
        │         DEPLOYMENT
        │         Factory deployment update
        │
 Yesterday
        ●──────── Physical Intelligence
        │         MODEL
        │         New model released
        │
```

The timeline line should visually communicate:

- chronological order
- continuous industry development
- milestones
- historical trace

---

# 8. Timeline Event Card

Each event contains:

```text
Time

Company
Robot / Product

Category

Title

Short summary

Source confidence

Optional:
- image
- video thumbnail
- paper
- GitHub
- source link
```

Example:

```text
09:42

TESLA
Optimus

[ DATA ]

Tesla releases new teleoperation
training footage for Optimus.

The footage appears to show human
operators collecting manipulation
demonstrations.

Confirmed
Primary Source
```

---

# 9. Event Categories

Use fixed event categories.

```text
DATA
MODEL
HARDWARE
DEPLOYMENT
PRODUCTION
RESEARCH
FUNDING
PARTNERSHIP
HIRING
BENCHMARK
DEMO
PRODUCT
```

Recommended color mapping can be added later.

For MVP, category may simply use text badges.

---

# 10. Event Importance

Optional field:

```text
NORMAL
IMPORTANT
MAJOR
```

Visual display:

```text
● normal

◆ important

★ major
```

Major events should be visible while scrolling.

Example:

```text
★ Tesla begins Optimus factory deployment
```

---

# 11. Confidence / Evidence Status

Every event should have one intelligence confidence state.

```text
CONFIRMED
REPORTED
INFERRED
RUMOR
```

Meaning:

### CONFIRMED

Official company source or primary evidence.

Examples:

- official website
- company X account
- earnings call
- paper
- GitHub
- SEC filing
- product page

### REPORTED

Trusted secondary media.

Examples:

- Reuters
- Bloomberg
- CNBC
- Financial Times
- TechCrunch

### INFERRED

Reasonable technical inference based on evidence.

Must clearly display:

> Inference, not officially confirmed.

### RUMOR

Community or unverified information.

This should be visually obvious.

---

# 12. Source Type

```text
PRIMARY
SECONDARY
COMMUNITY
```

Primary sources include:

```text
Company Website
Company Blog
X / Twitter
YouTube
Research Paper
GitHub
Patent
Earnings Call
SEC Filing
Job Posting
```

Secondary:

```text
Reuters
Bloomberg
CNBC
TechCrunch
The Information
Other media
```

Community:

```text
Reddit
X discussion
Forum
WeChat
Zhihu
Discord
```

---

# 13. Event Detail Page

When a user taps a timeline event:

```text
Timeline
   ↓
Event Detail
```

Example layout:

```text
< Back

TESLA
Optimus

DATA

New teleoperation training
footage released

September 27, 2026
09:42

--------------------------------

Summary

Tesla released footage showing
operators collecting manipulation
demonstrations for Optimus.

--------------------------------

Why It Matters

This indicates Tesla is continuing
to expand its real-world robot
training data pipeline.

--------------------------------

What Changed

Previous:
Limited public examples

Now:
New manipulation tasks observed

--------------------------------

Technical Signals

Data Method:
Teleoperation

Environment:
Factory

Task:
Manipulation

Observation:
RGB

Action:
Robot control

--------------------------------

Evidence

CONFIRMED
Primary Source

Tesla X
Tesla YouTube

--------------------------------

Related

Optimus
Tesla
Teleoperation
Robot Data
```

---

# 14. Event Detail Structure

Every event detail should support these sections:

```text
Title

Company
Robot
Category
Date
Importance

Summary

Why It Matters

What Changed

Technical Signals

Evidence

Sources

Related Events

Related Companies

Related Robots

Related Technologies
```

Not all fields need to exist.

The UI should hide empty sections.

---

# 15. Technical Signals

This is one of the most important differentiators of the product.

Events related to robot learning or data should support:

```text
Data Collection Method
Observation
State
Action
Environment
Task
Robot Platform
Model
Dataset
Scale
```

---

# 16. Data Collection Method

Allowed values:

```text
TELEOPERATION
HUMAN_DEMONSTRATION
EGO_VIDEO
ROBOT_ROLLOUT
SIMULATION
SYNTHETIC_DATA
WEB_VIDEO
MOTION_CAPTURE
VR_CONTROL
UMI
OTHER
```

---

# 17. Observation

Examples:

```text
RGB
DEPTH
STEREO
WRIST_CAMERA
HEAD_CAMERA
TACTILE
FORCE
TORQUE
AUDIO
LIDAR
IMU
```

---

# 18. State

Examples:

```text
JOINT_POSITION
JOINT_VELOCITY
JOINT_TORQUE
END_EFFECTOR_POSE
GRIPPER_STATE
BASE_POSE
BODY_POSE
HAND_POSE
```

---

# 19. Action

Examples:

```text
JOINT_COMMAND
JOINT_VELOCITY_COMMAND
JOINT_TORQUE_COMMAND
END_EFFECTOR_DELTA
END_EFFECTOR_POSE
GRIPPER_COMMAND
BASE_COMMAND
LANGUAGE_ACTION
```

---

# 20. Task Types

```text
PICK_AND_PLACE
GRASP
SORT
FOLD
CLEAN
COOK
ASSEMBLY
PACKING
KITTING
NAVIGATION
LOCOMOTION
TOOL_USE
DOOR_OPENING
OBJECT_MANIPULATION
OTHER
```

---

# 21. Company Page

Company page URL:

```text
/company/tesla
/company/figure-ai
/company/physical-intelligence
```

Layout:

```text
Tesla

Overview

Robots
Optimus

Technologies

Latest Events

2026
│
● Optimus production update
│
● New hand demonstrated
│
● Teleoperation data collection
│
● Factory deployment
```

The company page should essentially be a **filtered timeline**.

---

# 22. Robot Page

Example:

```text
/robot/tesla-optimus
```

Layout:

```text
Optimus

Tesla

Status:
Development / Deployment / Production

Generation:
Gen 3

--------------------------------

Latest Intelligence

Timeline

--------------------------------

Hardware

Hands
DOF
Battery
Compute
Sensors
Payload

--------------------------------

Learning

Teleoperation
Robot Data
Vision
VLA
Simulation

--------------------------------

Deployment

Factories
Task types

--------------------------------

Related Events
```

For MVP, most fields may be optional.

---

# 23. Search

Search should work across:

```text
Company
Robot
Event
Technology
Dataset
Model
Topic
```

Examples:

```text
Optimus

teleoperation

dexterous hand

robot data

VLA

Figure BMW

Physical Intelligence
```

---

# 24. Filters

Homepage filter button opens a bottom sheet.

Example:

```text
Filter

Company
[ Tesla ]
[ Figure ]
[ 1X ]
[ Unitree ]

Category
[ Data ]
[ Model ]
[ Hardware ]
[ Deployment ]

Confidence
[ Confirmed ]
[ Reported ]
[ Inferred ]

Date
Today
7 Days
30 Days
All
```

---

# 25. Default Tracked Companies

Initial companies:

```text
Tesla
Figure AI
1X
Physical Intelligence
Google DeepMind
Boston Dynamics
Agility Robotics
Unitree
Apptronik
Sanctuary AI

智元机器人
银河通用
傅利叶智能
逐际动力
星海图
Spirit AI
```

The system must make it easy to add more companies.

---

# 26. Main Topics

```text
Humanoid Robots
Robot Foundation Models
VLA
Robot Data
Teleoperation
Dexterous Hands
Manipulation
World Models
Simulation
Synthetic Data
Robot Deployment
Robot Production
Embodied AI Infrastructure
```

---

# 27. Database Model

Recommended relational model.

---

# 28. Event Table

```sql
events

id
slug

title
summary
why_it_matters
what_changed

category
importance
confidence

published_at
event_date

company_id
robot_id

source_type

created_at
updated_at
```

---

# 29. Company Table

```sql
companies

id
slug

name
name_cn

description

country

website
x_url
youtube_url
github_url

logo_url

created_at
updated_at
```

---

# 30. Robot Table

```sql
robots

id
slug

name
company_id

generation
status

description

image_url

created_at
updated_at
```

---

# 31. Source Table

```sql
sources

id

event_id

title
url

publisher

source_type

published_at

created_at
```

---

# 32. Technical Signal Table

```sql
technical_signals

id

event_id

data_collection_method

environment

task

model

dataset

notes
```

---

# 33. Observation Table

```sql
event_observations

event_id
observation_type
```

---

# 34. State Table

```sql
event_states

event_id
state_type
```

---

# 35. Action Table

```sql
event_actions

event_id
action_type
```

---

# 36. Tags

```sql
tags

id
name
slug
```

Mapping:

```sql
event_tags

event_id
tag_id
```

---

# 37. Example Event JSON

```json
{
  "id": "evt_001",
  "slug": "tesla-optimus-teleoperation-training-sep-2026",
  "company": {
    "name": "Tesla",
    "slug": "tesla"
  },
  "robot": {
    "name": "Optimus",
    "slug": "optimus"
  },
  "category": "DATA",
  "importance": "IMPORTANT",
  "confidence": "CONFIRMED",
  "title": "Tesla releases new Optimus teleoperation training footage",
  "summary": "Tesla published footage showing human operators collecting manipulation demonstrations for Optimus.",
  "why_it_matters": "The footage provides another signal that Tesla is expanding its real-world robot training data pipeline.",
  "event_date": "2026-09-27T09:42:00Z",
  "technical_signals": {
    "data_collection_method": "TELEOPERATION",
    "environment": "FACTORY",
    "tasks": [
      "GRASP",
      "OBJECT_MANIPULATION"
    ],
    "observations": [
      "RGB"
    ],
    "states": [
      "JOINT_POSITION",
      "GRIPPER_STATE"
    ],
    "actions": [
      "JOINT_COMMAND",
      "GRIPPER_COMMAND"
    ]
  },
  "sources": [
    {
      "publisher": "Tesla",
      "source_type": "PRIMARY",
      "url": "https://example.com"
    }
  ]
}
```

---

# 38. API Design

Suggested endpoints.

Timeline:

```http
GET /api/events
```

Filters:

```http
GET /api/events?company=tesla
GET /api/events?category=data
GET /api/events?confidence=confirmed
GET /api/events?days=7
```

Single event:

```http
GET /api/events/:slug
```

Companies:

```http
GET /api/companies
GET /api/companies/:slug
```

Robots:

```http
GET /api/robots
GET /api/robots/:slug
```

Search:

```http
GET /api/search?q=teleoperation
```

---

# 39. Pagination

Use cursor pagination.

Example:

```http
GET /api/events?cursor=xxx
```

Response:

```json
{
  "items": [],
  "nextCursor": "xxx"
}
```

Homepage should use infinite scroll.

---

# 40. Recommended Frontend Stack

Suggested:

```text
Next.js
TypeScript
Tailwind CSS
shadcn/ui
Lucide Icons
```

Optional:

```text
Framer Motion
```

Use animations very lightly.

---

# 41. Recommended Backend

Simple MVP:

```text
Next.js API
PostgreSQL
Prisma
```

or:

```text
Next.js
Supabase
PostgreSQL
```

Recommended for fast development:

```text
Next.js + Supabase
```

---

# 42. Data Collection Architecture

Future architecture:

```text
RSS
Company Websites
X
YouTube
GitHub
arXiv
News
Job Pages
Patents
Financial Reports

        ↓

Crawler / API

        ↓

Raw Sources

        ↓

AI Extraction

        ↓

Entity Recognition

Company
Robot
Model
Technology

        ↓

Classification

DATA
MODEL
HARDWARE
DEPLOYMENT
...

        ↓

Deduplication

        ↓

Human Review

        ↓

Event Database

        ↓

Timeline
```

---

# 43. Admin Panel

MVP should include a basic admin interface.

URL:

```text
/admin
```

Features:

```text
Create Event

Edit Event

Delete Event

Create Company

Create Robot

Add Source

Change Confidence

Change Category

Set Importance

Publish / Draft
```

---

# 44. Event Creation Form

Fields:

```text
Title

Company
Robot

Category
Importance
Confidence

Event Date

Summary

Why It Matters

What Changed

Technical Signals

Sources

Tags

Publish
```

---

# 45. Raw Source Workflow

Eventually support:

```text
Paste URL
   ↓
Fetch Source
   ↓
AI Extract
   ↓
Generate Draft Event
   ↓
Human Review
   ↓
Publish
```

This is highly recommended for Phase 2.

---

# 46. Mobile UI Principles

The mobile layout should feel dense but readable.

Recommended:

```text
max-width: 480px
```

Desktop:

```text
center content
```

Example:

```text
Desktop

┌──────────────────────────────────────────────┐
│                                              │
│              420px content                   │
│                                              │
│              Timeline                        │
│                                              │
└──────────────────────────────────────────────┘
```

Do not turn desktop into a completely different experience.

---

# 47. Visual Style

Recommended aesthetic:

```text
Minimal
Technical
Industrial
Intelligence
Clean
Dark / Light compatible
```

Avoid:

```text
Traditional news homepage
Too many cards
Large hero banners
Advertising-style layout
Complex dashboard
```

The timeline itself should be the visual identity.

---

# 48. Typography

Recommended hierarchy:

```text
Company
12px / uppercase

Title
17–20px / semibold

Summary
14–15px

Metadata
12px
```

The content should remain easy to scan.

---

# 49. Event Card Interaction

Tap anywhere on event:

```text
→ Event Detail
```

Tap company:

```text
→ Company Page
```

Tap robot:

```text
→ Robot Page
```

Tap tag:

```text
→ Filter Timeline
```

---

# 50. Date Grouping

Events should be grouped automatically.

Example:

```text
Today

Yesterday

September 25

September 24

September 23
```

For older events:

```text
September 2026

August 2026

July 2026
```

---

# 51. Milestone Mode

In addition to normal timeline mode, future version may support:

```text
All Events

Milestones Only
```

Milestones only show:

```text
Major hardware generation

Major model release

Factory deployment

Mass production

Major funding

Major partnership

Major dataset release
```

Example:

```text
2024
● Optimus Gen 2

2025
● Factory pilot

2026
● Gen 3
● Production ramp

2027
● External deployment
```

This is useful for company and robot pages.

---

# 52. Home Page MVP

MVP homepage should only contain:

```text
Header

Search

Filter

Vertical Timeline

Infinite Scroll

Bottom Navigation
```

Do not overbuild.

---

# 53. MVP Scope

## Phase 1

Manual intelligence database.

Build:

```text
Homepage Timeline
Event Detail
Company Page
Search
Filter
Admin CRUD
```

Data initially entered manually.

Goal:

> Validate the product experience.

---

# 54. Phase 2

Semi-automated intelligence ingestion.

Add:

```text
Paste URL

AI Summary

AI Classification

Company Recognition

Robot Recognition

Duplicate Detection

Draft Event
```

Human approves before publish.

---

# 55. Phase 3

Automated monitoring.

Sources:

```text
Company sites
RSS
X
YouTube
GitHub
arXiv
News
Job pages
```

Pipeline:

```text
Monitor
↓
Detect
↓
Extract
↓
Classify
↓
Draft
↓
Review
↓
Publish
```

---

# 56. Phase 4

Embodied AI Knowledge Graph

Entities:

```text
Company

Robot

Model

Dataset

Technology

Person

Factory

Partner

Data Collection Method
```

Relationships:

```text
Company
  BUILDS
Robot

Robot
  USES
Model

Company
  PARTNERS_WITH
Company

Robot
  DEPLOYED_AT
Factory

Model
  TRAINED_ON
Dataset

Dataset
  COLLECTED_WITH
Teleoperation
```

---

# 57. Important Product Differentiator

The product should focus on:

```text
What happened?

What changed?

Why does it matter?

What technical signal does it reveal?

What evidence supports it?
```

This is more valuable than simply summarizing a news article.

---

# 58. Special Focus: Robot Learning

A core product advantage should be tracking:

```text
How robots learn.
```

For every relevant event, try to identify:

```text
Data Source

Observation

State

Action

Task

Environment

Training Method

Model

Deployment Feedback
```

Long-term:

```text
Robot
  ↓
Data
  ↓
Model
  ↓
Deployment
  ↓
New Data
```

Track this flywheel for every major company.

---

# 59. Suggested Homepage Copy

Header:

```text
Embodied AI
Intelligence Tracker
```

Subtitle:

```text
Track how robots evolve, deploy, and learn.
```

Alternative:

```text
Real-time intelligence for embodied AI.
```

Core slogan:

```text
We don't just track robots.
We track how robots learn.
```

---

# 60. Suggested URL Structure

```text
/

/event/:slug

/company/:slug

/robot/:slug

/topic/:slug

/search

/admin
```

---

# 61. Suggested Project Structure

```text
src/

  app/

    page.tsx

    event/
      [slug]/
        page.tsx

    company/
      [slug]/
        page.tsx

    robot/
      [slug]/
        page.tsx

    search/
      page.tsx

    admin/
      page.tsx

    api/
      events/
      companies/
      robots/
      search/

  components/

    timeline/
      Timeline.tsx
      TimelineEvent.tsx
      TimelineDateGroup.tsx
      TimelineMarker.tsx

    event/
      EventHeader.tsx
      EventSummary.tsx
      EventEvidence.tsx
      TechnicalSignals.tsx

    company/
      CompanyHeader.tsx
      CompanyTimeline.tsx

    shared/
      Badge.tsx
      SearchBar.tsx
      FilterSheet.tsx
      BottomNav.tsx

  lib/

    db.ts
    types.ts
    constants.ts

  services/

    events.ts
    companies.ts
    robots.ts
```

---

# 62. TypeScript Types

```ts
export type EventCategory =
  | "DATA"
  | "MODEL"
  | "HARDWARE"
  | "DEPLOYMENT"
  | "PRODUCTION"
  | "RESEARCH"
  | "FUNDING"
  | "PARTNERSHIP"
  | "HIRING"
  | "BENCHMARK"
  | "DEMO"
  | "PRODUCT";

export type Confidence =
  | "CONFIRMED"
  | "REPORTED"
  | "INFERRED"
  | "RUMOR";

export type Importance =
  | "NORMAL"
  | "IMPORTANT"
  | "MAJOR";

export interface IntelligenceEvent {
  id: string;
  slug: string;

  title: string;
  summary?: string;
  whyItMatters?: string;
  whatChanged?: string;

  category: EventCategory;
  confidence: Confidence;
  importance: Importance;

  eventDate: string;

  company?: Company;
  robot?: Robot;

  sources: Source[];

  technicalSignals?: TechnicalSignals;
}
```

---

# 63. Demo Data

Seed the MVP with at least 30–50 events.

Companies:

```text
Tesla
Figure
1X
Physical Intelligence
Boston Dynamics
Unitree
智元
银河通用
```

This is enough to make the timeline feel alive.

---

# 64. Acceptance Criteria

The MVP is complete when:

### Homepage

- User sees chronological event timeline.
- Timeline works well on 390px mobile screen.
- User can scroll infinitely.
- User can tap any event.
- User can filter by category.
- User can search.

### Event

- User can see structured summary.
- User can see company.
- User can see robot.
- User can see confidence.
- User can see source links.
- Technical signals display when available.

### Company

- User can open a company page.
- User sees all events for that company.
- Events are ordered chronologically.

### Admin

- Admin can create an event.
- Admin can edit an event.
- Admin can publish an event.

---

# 65. Codex Implementation Priority

Recommended development order:

```text
1. Database schema

2. Seed demo data

3. Timeline UI

4. Event detail page

5. Company page

6. Search

7. Filter

8. Admin CRUD

9. Responsive desktop layout

10. AI ingestion pipeline
```

---

# 66. Most Important Constraint

Do not build this as a traditional news portal.

The central visual metaphor must remain:

```text
TIME
 │
 ● Event
 │
 ● Event
 │
 ● Event
 │
 ● Event
 ↓
```

The user should feel:

> I am watching the history of embodied AI unfold in real time.

---

# 67. Final Product Vision

The first version is:

```text
Embodied AI Timeline
```

The second version becomes:

```text
Embodied AI Intelligence Database
```

The third version becomes:

```text
Embodied AI Knowledge Graph
```

And eventually:

```text
Global Embodied AI Intelligence Infrastructure
```

The product's long-term value is not the number of articles.

The value is:

```text
Structured historical intelligence
+
Technical signals
+
Source evidence
+
Company timelines
+
Robot evolution
+
Robot learning data
```

That database becomes the real asset.

# MeetChamp - Admin Guide

## Logging In

1. Navigate to the dashboard URL (your Vercel deployment)
2. Enter your admin email and password
3. Only users with `role = 'admin'` in the profiles table can access the dashboard

## Dashboard Overview

The main dashboard shows:
- **Meetings Today/Week/Month** counts
- **Active Agents** (agents with heartbeat in last 15 minutes)
- **Pending Tone Alerts** (unreviewed)
- **Processing Queue** (jobs waiting for OpenAI responses)
- **Weekly trend chart**

## Managing Users

1. Go to **Users** page
2. Click **Add User** to add a monitored employee
3. Required: Full name, email
4. Optional: Department, Microsoft email (needed for Teams transcript matching)
5. Users can be edited or deactivated (deactivated agents stop being monitored)

## Viewing Meetings

1. Go to **Meetings** page
2. Filter by category, status, date range
3. Click any meeting to see full details:
   - **Transcript**: Timestamped, with speaker labels. Badge shows source (Local/Teams)
   - **AI Summary**: Category-specific summary with key points
   - **Tone Alerts**: Flagged segments with severity levels

## Tone Alerts

1. Go to **Tone Alerts** page
2. Filter by severity (high/medium/low) and review status
3. Click the link icon to jump to the meeting detail
4. Click the checkmark to mark an alert as reviewed

## Analytics

The analytics page shows:
- Meetings per user (bar chart)
- Meetings by category (pie chart)
- Tone alert trends over 30 days (line chart)
- Transcript source breakdown (Local vs Teams)

## Deploying the Agent

1. Build the installer: `cd client-agent && npm run build`
2. Distribute `MeetChamp Setup.exe` to employees
3. On first launch, the employee signs in with Microsoft once
4. After that, the agent runs silently in the background

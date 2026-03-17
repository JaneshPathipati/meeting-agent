# MeetChamp - Azure AD App Registration Setup

## Step 1: Create App Registration

1. Go to [Azure Portal](https://portal.azure.com) > Azure Active Directory > App registrations
2. Click **New registration**
3. Name: `MeetChamp`
4. Supported account types: **Accounts in this organizational directory only** (Single tenant)
5. Redirect URI: Select **Public client/native (mobile & desktop)**, enter `http://localhost`
6. Click **Register**

## Step 2: Note the IDs

After registration, note:
- **Application (client) ID** → This is your `AZURE_CLIENT_ID`
- **Directory (tenant) ID** → This is your `AZURE_TENANT_ID`

## Step 3: Configure API Permissions

1. Go to **API permissions** > **Add a permission**
2. Select **Microsoft Graph** > **Delegated permissions**
3. Add these permissions:
   - `User.Read` (usually pre-added)
   - `Calendars.Read`
   - `OnlineMeetingTranscript.Read.All`
4. Click **Grant admin consent for [Your Organization]**

## Step 4: Create Client Secret (Optional)

If using Confidential Client flow:
1. Go to **Certificates & secrets** > **New client secret**
2. Description: `MeetChamp Agent`
3. Expiry: 24 months
4. Copy the **Value** → This is your `AZURE_CLIENT_SECRET`

> Note: For Public Client (desktop app) flow, a client secret is not required.
> The agent uses MSAL's interactive login which works with Public Client.

## Step 5: Configure Authentication

1. Go to **Authentication**
2. Under **Advanced settings**, set **Allow public client flows** to **Yes**
3. Save

## Step 6: Update Agent Config

Add these values to the agent's `.env` file:
```
AZURE_CLIENT_ID=your-application-client-id
AZURE_TENANT_ID=your-directory-tenant-id
AZURE_CLIENT_SECRET=your-client-secret (if using confidential client)
```

## Important Notes

- The admin must grant consent for the API permissions organization-wide
- Employees will be prompted to sign in with Microsoft on first agent launch
- After initial sign-in, the agent refreshes tokens silently
- If a token expires or is revoked, the agent will prompt for re-authentication
- Minimum permissions principle: only read access, no write permissions

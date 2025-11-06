# Email Notifications Setup Guide

The Order Tracker now supports email notifications! Users will receive emails when they subscribe to orders and when order status changes.

## Quick Setup (Gmail)

1. **Enable 2-Step Verification** in your Google Account
   - Go to https://myaccount.google.com/security
   - Enable 2-Step Verification

2. **Generate App Password**
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" and "Windows Computer" (or Other)
   - Click "Generate"
   - Copy the 16-character password

3. **Update .env file** with these lines:
   ```env
   EMAIL_SERVICE=gmail
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASS=your-16-char-app-password
   ```

4. **Restart the server**
   ```bash
   npm start
   ```

## Alternative: Generic SMTP

If you're not using Gmail, you can use any SMTP server:

```env
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=your-email@example.com
EMAIL_PASS=your-password
```

## Features

### 1. Subscription Confirmation
When users subscribe to an order:
- Subscription is saved to `subscriptions.json`
- Confirmation email sent immediately
- Email includes current order status and tracking link

### 2. Status Update Notifications
When an order status changes (via Advance button):
- All subscribers receive an email
- Email shows old status → new status
- Includes special messages for delivery milestones

### 3. Graceful Fallback
- If email is not configured, subscriptions still work
- Users see a message that emails aren't configured
- Perfect for development/testing without email setup

## Testing

1. **Subscribe to an order**:
   - Track order `1001` in the UI
   - Enter your email in "Subscribe for updates"
   - Click Subscribe
   - Check your email for confirmation

2. **Trigger status update**:
   - Click "Advance (demo)" button
   - Check your email for status update notification

3. **Check logs**:
   - Server logs show: `[Email] Sent to user@example.com`
   - Or: `[Email] Transporter not configured` if disabled

## Email Templates

Beautiful HTML emails with:
- 🚚 Order Tracker branding
- Royal theme (gold/purple gradients)
- Clear status badges
- Direct tracking links
- Responsive design

## Security Notes

- Never commit your `.env` file with real credentials
- Use App Passwords, not your actual Gmail password
- `.env` is already in `.gitignore`
- Consider using environment variables in production

## Troubleshooting

**Emails not sending?**
- Check that EMAIL_USER and EMAIL_PASS are set in .env
- Look for `[Email] Transporter configured` in server startup logs
- Gmail: Make sure you're using an App Password, not regular password
- Check spam/junk folder

**"Auth failed" errors?**
- Gmail: Verify 2-Step Verification is enabled
- Gmail: Generate a new App Password
- Other providers: Check SMTP credentials

**Subscriptions work but no emails?**
- Server shows: `[Email] Transporter not configured, skipping email`
- This is normal if you haven't set up email yet
- Subscriptions are still saved and will work once email is configured

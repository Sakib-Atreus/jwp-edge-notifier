# Supabase Edge Function – JW Player Firebase Notifications

This project uses a **Supabase Edge Function** to listen for **JW Player webhooks** and send **Firebase Cloud Messaging (FCM)** push notifications when a new video is uploaded or updated.

Notifications are stored in Supabase and delivered to all registered devices.

---

## Features

- Supabase Edge Functions (Deno)
- Firebase Cloud Messaging (FCM v1)
- JW Player webhook integration
- Device registration with FCM tokens
- Notification persistence
- Fetch notification history per device

---

## Architecture Flow

1. Client registers device with FCM token
2. JW Player sends webhook on media upload/update
3. Edge Function saves notification to Supabase
4. Notification is linked to all devices
5. Firebase sends push notifications
6. Client fetches notification history when needed


## License

© 2026 Sakib Dev. All rights reserved.
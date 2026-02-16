import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";
import { create } from "https://deno.land/x/djwt@v2.9/mod.ts";

const allowedEvents = [
  "conversions_complete",
  "channel_active",
  "channel_idle",
  "channel_created",
  "media_available",
  "media_created",
  "media_deleted",
  "media_reuploaded",
  "media_updated",
  "thumbnail_created",
  "thumbnail_deleted",
  "track_created",
  "track_deleted"
];


// ================== SUPABASE ==================
const supabase = createClient(
  Deno.env.get("PROJECT_URL")!,
  Deno.env.get("SERVICE_ROLE_KEY")!
);

// ================== FIREBASE SERVICE ACCOUNT ==================
const serviceAccount = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);

// private key formatting
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

// ================== GET PRIVATE KEY ==================
async function getPrivateKey() {
  const key = serviceAccount.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binaryKey = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));

  return await crypto.subtle.importKey(
    "pkcs8",
    binaryKey.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// ================== GET FIREBASE ACCESS TOKEN ==================
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const privateKey = await getPrivateKey();

  const jwt = await create({ alg: "RS256", typ: "JWT" }, payload, privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await res.json();

  if (!data.access_token) {
    console.error("Firebase Auth Error:", data);
    throw new Error("Failed to get Firebase access token");
  }

  return data.access_token;
}

// ================== SEND FCM ==================
async function sendFCM(tokens: string[], payload: any) {
  if (!tokens.length) return;

  const accessToken = await getAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;

  await Promise.all(
    tokens.map(async (token) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            notification: payload.notification,
            data: payload.data,
          },
        }),
      });

      const result = await res.json();
      console.log("FCM Result:", result);
    })
  );
}

// ================== EDGE FUNCTION ==================
serve(async (req) => {
  try {
    const url = new URL(req.url);

    // ================== REGISTER DEVICE API ==================
    if (req.method === "POST" && url.pathname.endsWith("/register-device")) {
      const { deviceId, fcmToken, platform } = await req.json();

      if (!deviceId || !fcmToken) {
        return new Response(
          JSON.stringify({ error: "deviceId & fcmToken required" }),
          { status: 400 }
        );
      }

      const { error } = await supabase.from("devices").upsert(
        {
          device_id: deviceId,
          fcm_token: fcmToken,
          platform: platform || "unknown",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "device_id" }
      );

      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    // For only test api: test-fcm endpoint
    if (req.method === "POST" && url.pathname.endsWith("/test-fcm")) {
      const { fcmToken, title, body } = await req.json();

      if (!fcmToken) {
        return new Response(JSON.stringify({ error: "fcmToken required" }), {
          status: 400,
        });
      }

      await sendFCM(
        [fcmToken],
        title || "Test Notification",
        body || "Hello from Supabase!"
      );

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    // ================== FETCH DEVICE NOTIFICATIONS ==================
    if (req.method === "GET" && url.pathname.startsWith("/notifications/")) {
      const deviceIdText = url.pathname.split("/").pop();

      if (!deviceIdText) {
        return new Response(JSON.stringify({ error: "deviceId required" }), {
          status: 400,
        });
      }

      // Step 1: Get UUID from device_id (text)
      const { data: deviceData, error: deviceError } = await supabase
        .from("devices")
        .select("id")
        .eq("device_id", deviceIdText)
        .single();

      if (deviceError || !deviceData) {
        return new Response(JSON.stringify({ error: "Device not found" }), {
          status: 404,
        });
      }

      const deviceUUID = deviceData.id;

      // Step 2: Fetch notifications by UUID
      const { data, error } = await supabase
        .from("device_notifications")
        .select(
          `
      id,
      read,
      created_at,
      notifications (
        id,
        type,
        title,
        body,
        data,
        created_at
      )
    `
        )
        .eq("device_id", deviceUUID)
        .order("created_at", { ascending: false });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
        });
      }

      return new Response(JSON.stringify(data), { status: 200 });
    }

    // ================== JW PLAYER WEBHOOK ==================
    if (req.method === "POST") {
      const event = await req.json();

      console.log("JW Player Event:", event);

      const eventType = event.event; // JW Player event type
      const media = event.data;

      // Only handle media events
      if (!allowedEvents.includes(eventType)) {
        return new Response(JSON.stringify({ ignored: true }), { status: 200 });
      }

      const mediaId = media.media_id;
      const titleText = media.title || "New Media";

      // ================== FRONTEND FORMAT PAYLOAD ==================
      const payload = {
        notification: {
          title:
            eventType === "media_created"
              ? "New Video Uploaded"
              : "Video Updated",
          body: titleText,
        },
        data: {
          type: "media",
          id: mediaId,
        },
      };

      // ================== SAVE TO DB ==================
      const { data: savedNotification, error } = await supabase
        .from("notifications")
        .insert({
          type: payload.data.type, // must match CHECK constraint
          title: payload.notification.title,
          body: payload.notification.body,
          data: payload.data, // jsonb
        })
        .select()
        .single();

      if (error) {
        console.error("DB Error:", error);
        return new Response(
          JSON.stringify({ error: "DB insert failed", details: error.message }),
          { status: 500 }
        );
      }

      // ================== GET FCM TOKENS ==================
      const { data: devices, error: devicesError } = await supabase
        .from("devices")
        .select("id, fcm_token");

      // const tokens = devices?.map((d) => d.fcm_token).filter(Boolean) || [];

      if (devicesError || !devices?.length) {
        console.error("No devices found", devicesError);
      }

      const tokens: string[] = [];

      await Promise.all(
        devices.map(async (device) => {
          tokens.push(device.fcm_token);

          await supabase.from("device_notifications").insert({
            device_id: device.id,
            notification_id: savedNotification.id,
            read: false,
          });
        })
      );

      // ================== SEND PUSH NOTIFICATION ==================
      await sendFCM(tokens, payload);

      return new Response(
        JSON.stringify({
          success: true,
          sent: tokens.length,
          notification: savedNotification,
        }),
        { status: 200 }
      );
    }

    return new Response("Not Found", { status: 404 });
  } catch (err) {
    console.error("Edge Function Error:", err);
    return new Response(
      JSON.stringify({ error: "Failed", details: String(err) }),
      { status: 500 }
    );
  }
});

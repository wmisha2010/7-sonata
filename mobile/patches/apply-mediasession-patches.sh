#!/bin/bash
# Pre-build media-session patcher + guards for 7-Sonata mobile.
#
# IMPORTANT HISTORY (do not regress):
#   v1.6.0 (user-verified) used the ORIGINAL @jofr/capacitor-media-session
#   plugin with an EMPTY MainActivity and a bare AndroidManifest. Deep JS
#   "hardening" (playpause action, visibilitychange/3s retries, manual
#   <service> in the app manifest, androidScheme=http) BROKE the shade on
#   real devices and was fully reverted. The service/receiver/permissions
#   must keep coming from the plugin's OWN library manifest via the merger.
#
# v1.7.3 — two MINIMAL, surgical native fixes (proven root causes):
#   FIX 1 (playpause): PlaybackStateCompat.toKeyCode() accepts only a SINGLE
#        action. The plugin built play/pause notification PendingIntents with
#        the combined flag (ACTION_PLAY_PAUSE | ACTION_PLAY) => toKeyCode
#        returned KEYCODE_UNKNOWN => buildMediaButtonPendingIntent returned
#        null => the play/pause buttons in the shade rendered but were DEAD.
#        Fix: single ACTION_PLAY / ACTION_PAUSE (KEYCODE_MEDIA_PLAY/PAUSE ->
#        onPlay()/onPause()). Verified on the compiled bytecode: the
#        PendingIntents are built with long 4 / long 2 constants.
#   FIX 2 (artwork): the plugin's urlToBitmap fetched covers with a bare
#        HttpURLConnection (no UA, NO timeouts) on the single Capacitor
#        plugin thread, and setMetadata propagated any failure — killing the
#        whole metadata update and stalling every queued media-session call.
#        Fix: browser UA + 10s timeouts + never throw + clear stale covers.
#   The JS side additionally pre-resolves artwork to base64 data URLs via
#   CapacitorHttp (resolveArtworkSrc in music-player.tsx), so the native
#   fetch below is only a fallback path.
set -e
cd "$(dirname "$0")/.."

PJ="node_modules/@jofr/capacitor-media-session/android/src/main/java/io/github/jofr/capacitor/mediasessionplugin"

python3 - "$PJ" <<'PYEOF'
import sys, pathlib

pj = pathlib.Path(sys.argv[1])
svc = pj / "MediaSessionService.java"
plg = pj / "MediaSessionPlugin.java"

# ---------- FIX 1: play/pause notification PendingIntents ----------
PLAY_OLD = 'MediaButtonReceiver.buildMediaButtonPendingIntent(this, (PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_PLAY))'
PAUSE_OLD = 'MediaButtonReceiver.buildMediaButtonPendingIntent(this, (PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_PAUSE))'
PLAY_NEW = 'MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_PLAY)  // SonataFix(playpause): single action, combined flag resolved to KEYCODE_UNKNOWN and a null (dead) PendingIntent'
PAUSE_NEW = 'MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_PAUSE)  // SonataFix(playpause): single action, combined flag resolved to KEYCODE_UNKNOWN and a null (dead) PendingIntent'

s = svc.read_text()
changed1 = False
if PLAY_OLD in s:
    s = s.replace(PLAY_OLD, PLAY_NEW)
    changed1 = True
if PAUSE_OLD in s:
    s = s.replace(PAUSE_OLD, PAUSE_NEW)
    changed1 = True
if PLAY_OLD in s or PAUSE_OLD in s:
    print("GUARD FAILED: could not fully patch play/pause PendingIntents", file=sys.stderr)
    sys.exit(1)
if "SonataFix(playpause)" not in s:
    print("GUARD FAILED: playpause fix marker missing after patch", file=sys.stderr)
    sys.exit(1)
svc.write_text(s)
print("FIX 1 (playpause):", "applied" if changed1 else "already present")

# ---------- FIX 2: robust artwork loading ----------
META_OLD = '''        final JSArray artworkArray = call.getArray("artwork");
        final List<JSONObject> artworkList = artworkArray.toList();
        for (JSONObject artwork : artworkList) {
            String src = artwork.getString("src");
            if (src != null) {
                this.artwork = urlToBitmap(src);
            }
        }
'''
META_NEW = '''        // SonataFix(artwork): never let artwork failures kill the metadata
        // update (the plugin thread is single-threaded — a throw or a hang
        // here stalls every queued media-session call), and clear stale
        // covers when a track ships without artwork.
        final JSArray artworkArray = call.getArray("artwork");
        if (artworkArray != null) {
            Bitmap loadedArtwork = null;
            try {
                final List<JSONObject> artworkList = artworkArray.toList();
                for (JSONObject artwork : artworkList) {
                    String src = artwork.getString("src");
                    if (src == null || src.isEmpty()) continue;
                    Bitmap bmp = urlToBitmap(src);
                    if (bmp != null) { loadedArtwork = bmp; break; }
                }
            } catch (Exception artEx) {
                Log.w(TAG, "Artwork load failed: " + artEx);
            }
            this.artwork = loadedArtwork;
        }
'''

FETCH_OLD = '''    private Bitmap urlToBitmap(String url) throws IOException {
        final boolean blobUrl = url.startsWith("blob:");
        if (blobUrl) {
            Log.i(TAG, "Converting Blob URLs to Bitmap for media artwork is not yet supported");
        }

        final boolean httpUrl = url.startsWith("http");
        if (httpUrl) {
            HttpURLConnection connection = (HttpURLConnection) (new URL(url)).openConnection();
            connection.setDoInput(true);
            connection.connect();
            InputStream inputStream = connection.getInputStream();
            return BitmapFactory.decodeStream(inputStream);
        }
'''
FETCH_NEW = '''    private Bitmap urlToBitmap(String url) {
        final boolean blobUrl = url.startsWith("blob:");
        if (blobUrl) {
            Log.i(TAG, "Converting Blob URLs to Bitmap for media artwork is not yet supported");
        }

        final boolean httpUrl = url.startsWith("http");
        if (httpUrl) {
            // SonataFix(artwork): browser UA + hard timeouts. The default
            // HttpURLConnection has NO read/connect timeout and a Dalvik UA
            // that some CDNs reject; a stall here would freeze the single
            // Capacitor plugin thread.
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) (new URL(url)).openConnection();
                connection.setDoInput(true);
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(10000);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
                connection.connect();
                InputStream inputStream = connection.getInputStream();
                return BitmapFactory.decodeStream(inputStream);
            } catch (IOException fetchEx) {
                Log.w(TAG, "Artwork fetch failed: " + fetchEx);
                return null;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
'''

p = plg.read_text()
changed2 = False
if META_OLD in p:
    p = p.replace(META_OLD, META_NEW)
    changed2 = True
if FETCH_OLD in p:
    p = p.replace(FETCH_OLD, FETCH_NEW)
    changed2 = True
if META_OLD in p or FETCH_OLD in p:
    print("GUARD FAILED: could not fully patch artwork loading", file=sys.stderr)
    sys.exit(1)
if "SonataFix(artwork)" not in p:
    print("GUARD FAILED: artwork fix marker missing after patch", file=sys.stderr)
    sys.exit(1)
plg.write_text(p)
print("FIX 2 (artwork):", "applied" if changed2 else "already present")

# ---------- FIX 3: full exit when the task is swiped away ----------
SVC_ANCHOR = '''    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        MediaButtonReceiver.handleIntent(mediaSession, intent);
        return super.onStartCommand(intent, flags, startId);
    }
'''
SVC_TASKREMOVED = '''    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        MediaButtonReceiver.handleIntent(mediaSession, intent);
        return super.onStartCommand(intent, flags, startId);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // SonataFix(taskremoved): closing the app from recents ("Закрыть all"
        // or a swipe) must FULLY exit it. This foreground service kept the
        // process — and with it the WebView audio and the shade notification
        // — alive after the task was gone, which looked like "the app
        // refuses to close". Tear everything down: drop the notification,
        // stop the service, then kill the process so the WebView (and any
        // still-playing media) dies with it. Plain home/screen-off is NOT
        // affected — background playback keeps working (v1.7.4).
        super.onTaskRemoved(rootIntent);
        stopForeground(true);
        stopSelf();
        android.os.Process.killProcess(android.os.Process.myPid());
    }
'''

s = svc.read_text()
changed3 = False
if "SonataFix(taskremoved)" not in s:
    if SVC_ANCHOR not in s:
        print("GUARD FAILED: onStartCommand anchor not found in MediaSessionService", file=sys.stderr)
        sys.exit(1)
    s = s.replace(SVC_ANCHOR, SVC_TASKREMOVED, 1)
    changed3 = True
if "SonataFix(taskremoved)" not in s:
    print("GUARD FAILED: taskremoved fix marker missing after patch", file=sys.stderr)
    sys.exit(1)
svc.write_text(s)
print("FIX 3 (taskremoved):", "applied" if changed3 else "already present")
PYEOF

# Guard: the app manifest must stay bare — the MediaSessionService and
# MediaButtonReceiver must keep coming from the plugin's library manifest.
AM="android/app/src/main/AndroidManifest.xml"
if grep -q "MediaSessionService" "$AM"; then
  echo "GUARD FAILED: app manifest has a hand-added <service> — revert it;" >&2
  echo "  the merger adds the service from the plugin library manifest." >&2
  exit 1
fi
echo "Guard OK: app manifest is bare (service comes from the plugin AAR merger)."
echo "All media-session patches applied + guards passed."

package com.zai.sonata;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.view.KeyEvent;

import androidx.media.session.MediaButtonReceiver;

/**
 * SonataFix v1.8.0: home-screen playback widget.
 *
 * Button taps are translated into the SAME media-button broadcasts the
 * wired-headset path uses (ACTION_MEDIA_BUTTON → MediaButtonReceiver →
 * MediaSession → plugin callbacks → JS). No custom JS event plumbing, no
 * new control path — the widget reuses the play/pause/next/prev wiring that
 * v1.7.3 proved on real devices. The play/pause PendingIntent carries the
 * concrete KEYCODE chosen at update() time (the JS side knows the playing
 * flag), so no framework state guessing is involved.
 */
public class SonataWidgetProvider extends AppWidgetProvider {
    public static final String ACTION_PLAY = "com.zai.sonata.widget.PLAY";
    public static final String ACTION_PAUSE = "com.zai.sonata.widget.PAUSE";
    public static final String ACTION_NEXT = "com.zai.sonata.widget.NEXT";
    public static final String ACTION_PREV = "com.zai.sonata.widget.PREV";

    private static int keycodeFor(String action) {
        if (ACTION_PLAY.equals(action)) return KeyEvent.KEYCODE_MEDIA_PLAY;
        if (ACTION_PAUSE.equals(action)) return KeyEvent.KEYCODE_MEDIA_PAUSE;
        if (ACTION_NEXT.equals(action)) return KeyEvent.KEYCODE_MEDIA_NEXT;
        if (ACTION_PREV.equals(action)) return KeyEvent.KEYCODE_MEDIA_PREVIOUS;
        return 0;
    }

    /** Build an explicit, immutable PendingIntent for a widget button. */
    public static PendingIntent buttonPendingIntent(Context ctx, String action, int requestCode) {
        Intent i = new Intent(ctx, SonataWidgetProvider.class).setAction(action);
        return PendingIntent.getBroadcast(
                ctx,
                requestCode,
                i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        final String action = intent != null ? intent.getAction() : null;
        final int keycode = action != null ? keycodeFor(action) : 0;
        if (keycode != 0) {
            // Route through the proven media-button path (headset controls).
            Intent mb = new Intent(Intent.ACTION_MEDIA_BUTTON);
            mb.setComponent(new ComponentName(context, MediaButtonReceiver.class));
            mb.putExtra(Intent.EXTRA_KEY_EVENT, new KeyEvent(KeyEvent.ACTION_DOWN, keycode));
            context.sendBroadcast(mb);
            return;
        }
        super.onReceive(context, intent);
    }
}

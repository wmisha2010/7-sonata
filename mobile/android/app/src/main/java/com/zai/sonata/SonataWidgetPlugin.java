package com.zai.sonata;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.view.View;
import android.widget.RemoteViews;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * SonataFix v1.8.0: local Capacitor plugin that lets the JS player push the
 * current track + play state into the home-screen widget. The player calls
 * update() on every track change and play/pause toggle; buttons are wired
 * once here (PendingIntents survive until the next update re-sets them).
 */
@CapacitorPlugin(name = "SonataWidget")
public class SonataWidgetPlugin extends Plugin {

    @PluginMethod
    public void update(PluginCall call) {
        try {
            Context ctx = getContext();
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            ComponentName cn = new ComponentName(ctx, SonataWidgetProvider.class);
            int[] ids = mgr.getAppWidgetIds(cn);
            if (ids == null || ids.length == 0) {
                call.resolve(); // no widgets on any home screen — nothing to do
                return;
            }
            String title = call.getString("title", "");
            String artist = call.getString("artist", "");
            boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
            String cover = call.getString("cover", "");

            RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.sonata_widget);
            views.setTextViewText(R.id.widget_title, title == null || title.isEmpty() ? "7-Sonata" : title);
            views.setTextViewText(R.id.widget_artist, artist == null ? "" : artist);

            Bitmap bmp = decodeDataUrl(cover);
            if (bmp != null) {
                views.setViewVisibility(R.id.widget_cover, View.VISIBLE);
                views.setImageViewBitmap(R.id.widget_cover, bmp);
            } else {
                views.setViewVisibility(R.id.widget_cover, View.INVISIBLE);
            }

            views.setImageViewResource(
                    R.id.widget_toggle,
                    playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play
            );
            // Tint the legacy framework media icons white for the dark widget.
            views.setInt(R.id.widget_prev, "setColorFilter", 0xFFFFFFFF);
            views.setInt(R.id.widget_toggle, "setColorFilter", 0xFFFFFFFF);
            views.setInt(R.id.widget_next, "setColorFilter", 0xFFFFFFFF);

            views.setOnClickPendingIntent(R.id.widget_prev,
                    SonataWidgetProvider.buttonPendingIntent(ctx, SonataWidgetProvider.ACTION_PREV, 71));
            // The toggle button embeds the concrete keycode chosen NOW — the
            // JS side knows whether playback is currently active.
            views.setOnClickPendingIntent(R.id.widget_toggle,
                    SonataWidgetProvider.buttonPendingIntent(ctx,
                            playing ? SonataWidgetProvider.ACTION_PAUSE : SonataWidgetProvider.ACTION_PLAY, 72));
            views.setOnClickPendingIntent(R.id.widget_next,
                    SonataWidgetProvider.buttonPendingIntent(ctx, SonataWidgetProvider.ACTION_NEXT, 73));

            mgr.updateAppWidget(cn, views);
            call.resolve();
        } catch (Exception e) {
            call.reject("widget update failed: " + e.getMessage());
        }
    }

    /** Decode "data:image/...;base64,…" artwork into a Bitmap (null on failure). */
    private static Bitmap decodeDataUrl(String dataUrl) {
        if (dataUrl == null || !dataUrl.startsWith("data:") || dataUrl.length() < 32) return null;
        final int comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        try {
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception e) {
            return null;
        }
    }
}

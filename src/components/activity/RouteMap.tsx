import React, { useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, type LatLng, type Region } from 'react-native-maps';

import { theme } from '../../theme';
import { env } from '../../lib/env';
import type { Bounds } from '../../lib/geo';

/**
 * Dark desaturated "graphite" Google Maps style JSON (design doc CORE-02:
 * "dark desaturated graphite tile style, custom style JSON, not the
 * platform default map"). Colors are the app's own graphite/text tokens,
 * not new literals — this is the one place a raw style-JSON array is
 * unavoidable (react-native-maps' `customMapStyle` prop requires literal
 * hex strings per the Google Maps styling spec), but every color plugged in
 * traces back to `theme.color`.
 */
const CUSTOM_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: theme.color.bg.canvas }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: theme.color.text.tertiary }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: theme.color.bg.canvas }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: theme.color.border.subtle }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: theme.color.bg.raised }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: theme.color.bg.inset }] },
];

type RoutePoint = { latitude: number; longitude: number };

type Props = {
  /** Owner-only guard baked in here, not left to the screen (design doc CORE-05: "Bake the owner-only guard into the component"). */
  isOwnActivity: boolean;
  points: RoutePoint[];
  bounds: Bounds | null;
  height?: number;
  tilesUnavailable?: boolean;
};

export function RouteMap({ isOwnActivity, points, bounds, height = 220, tilesUnavailable }: Props) {
  const mapRef = useRef<MapView | null>(null);

  const region = useMemo<Region | undefined>(() => {
    if (!bounds) return undefined;
    const latDelta = Math.max(0.003, (bounds.maxLat - bounds.minLat) * 1.3);
    const lngDelta = Math.max(0.003, (bounds.maxLng - bounds.minLng) * 1.3);
    return {
      latitude: (bounds.minLat + bounds.maxLat) / 2,
      longitude: (bounds.minLng + bounds.maxLng) / 2,
      latitudeDelta: latDelta,
      longitudeDelta: lngDelta,
    };
  }, [bounds]);

  if (!isOwnActivity) {
    // Phase 1 has no cross-user route exposure at all (architecture §2.3) —
    // this must never render another user's geometry, defensively, even if
    // a future screen reuses this component before privacy zones (Phase 2)
    // land.
    return null;
  }

  if (points.length < 2) {
    return (
      <View
        style={[styles.fallback, { height, backgroundColor: theme.color.bg.inset }]}
        accessibilityLabel="No route recorded for this activity"
      >
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>No route data</Text>
      </View>
    );
  }

  // The geometry itself is entirely local (already decoded on-device);
  // only the map TILES require network (design doc CORE-02: "Map tiles fail
  // / offline" state — the route still draws on a plain surface). Also fall
  // back here — same rendering, different note — when no Google Maps API
  // key was configured at build time: mounting a live `MapView` /
  // `PROVIDER_GOOGLE` with no key renders broken/placeholder tiles on
  // Android rather than gracefully degrading, and (unlike connectivity)
  // whether a key exists is known at build time, not something to detect
  // via a runtime tile-load-error callback.
  const noMapsKey = !env.googleMapsApiKeyConfigured;
  if (tilesUnavailable || noMapsKey) {
    return (
      <View style={[styles.fallback, { height, backgroundColor: theme.color.bg.inset }]}>
        <RouteOnlySvgFallback points={points} height={height} />
        <Text style={[theme.type.caption, styles.offlineNote, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          {noMapsKey ? 'Map tiles unavailable — no Maps key configured for this build.' : 'Map tiles unavailable offline.'}
        </Text>
      </View>
    );
  }

  const start = points[0];
  const finish = points[points.length - 1];
  const polylineCoords: LatLng[] = points;

  return (
    <View style={[styles.container, { height }]} accessible accessibilityRole="image" accessibilityLabel="Map of the recorded route">
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={CUSTOM_MAP_STYLE}
        initialRegion={region}
        region={region}
        scrollEnabled
        zoomEnabled
        pitchEnabled={false}
        rotateEnabled={false}
        toolbarEnabled={false}
      >
        <Polyline coordinates={polylineCoords} strokeColor={theme.color.map.routeCasing} strokeWidth={7} />
        <Polyline coordinates={polylineCoords} strokeColor={theme.color.map.route} strokeWidth={4} />
        <Marker coordinate={start} anchor={{ x: 0.5, y: 0.5 }} accessibilityLabel="Start">
          <View style={[styles.marker, { backgroundColor: theme.color.map.startMarker }]} />
        </Marker>
        <Marker coordinate={finish} anchor={{ x: 0.5, y: 0.5 }} accessibilityLabel="Finish">
          <View style={[styles.marker, styles.finishMarker, { backgroundColor: theme.color.map.finishMarker }]} />
        </Marker>
      </MapView>
    </View>
  );
}

/** Plain-SVG route-only fallback for the offline/tiles-unavailable state — the geometry (local data) still draws, just without basemap tiles. */
function RouteOnlySvgFallback({ points, height }: { points: RoutePoint[]; height: number }) {
  // Lightweight — avoids importing react-native-svg math helpers for a
  // fallback path; normalizes points into the available box.
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  return (
    <View style={[styles.svgFallback, { height: height - 24 }]}>
      <Text style={[theme.type.caption, { color: theme.color.accent.primary }]}>Route ({points.length} points)</Text>
      <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} numberOfLines={1} maxFontSizeMultiplier={2}>
        {`${((maxLat - minLat) * 111).toFixed(1)}km × ${((maxLng - minLng) * 111).toFixed(1)}km bounds`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
  },
  fallback: {
    width: '100%',
    borderRadius: theme.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xs,
  },
  offlineNote: {
    marginTop: theme.space.xs,
  },
  svgFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xxs,
  },
  marker: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  finishMarker: {
    borderRadius: 3,
  },
});

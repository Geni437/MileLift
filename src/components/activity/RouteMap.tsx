import React, { useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map as MapLibreMap, Marker, type MapRef } from '@maplibre/maplibre-react-native';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

import { theme } from '../../theme';
import type { Bounds } from '../../lib/geo';

/**
 * OpenStreetMap raster tiles — free, no API key/account of any kind (unlike
 * react-native-maps' Google-Maps-SDK dependency on Android, which requires a
 * key just to initialize the native view regardless of which tiles are
 * shown). A `background` layer under the raster layer, plus reduced
 * `raster-opacity`/negative `raster-saturation`, approximates the app's dark
 * desaturated aesthetic (design doc CORE-02) without a paid/keyed vector
 * tile provider — a real (documented) visual compromise versus a full custom
 * vector style, not an oversight.
 */
const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': theme.color.bg.canvas } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.85, 'raster-saturation': -0.6, 'raster-brightness-max': 0.85 },
    },
  ],
};

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
  const mapRef = useRef<MapRef | null>(null);

  const cameraBounds = useMemo<[number, number, number, number] | undefined>(() => {
    if (!bounds) return undefined;
    return [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat];
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
  // / offline" state — the route still draws on a plain surface).
  if (tilesUnavailable) {
    return (
      <View style={[styles.fallback, { height, backgroundColor: theme.color.bg.inset }]}>
        <RouteOnlySvgFallback points={points} height={height} />
        <Text style={[theme.type.caption, styles.offlineNote, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          Map tiles unavailable offline.
        </Text>
      </View>
    );
  }

  const start = points[0];
  const finish = points[points.length - 1];
  const routeGeoJson: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: points.map((p) => [p.longitude, p.latitude]),
    },
  };

  return (
    <View style={[styles.container, { height }]} accessible accessibilityRole="image" accessibilityLabel="Map of the recorded route">
      <MapLibreMap
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE}
        touchRotate={false}
        touchPitch={false}
        attribution
      >
        <Camera initialViewState={cameraBounds ? { bounds: cameraBounds, padding: { top: 32, right: 32, bottom: 32, left: 32 } } : undefined} />

        <GeoJSONSource id="route" data={routeGeoJson}>
          <Layer
            id="route-casing"
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': theme.color.map.routeCasing, 'line-width': 7 }}
          />
          <Layer
            id="route-line"
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': theme.color.map.route, 'line-width': 4 }}
          />
        </GeoJSONSource>

        <Marker id="start" lngLat={[start.longitude, start.latitude]} anchor="center">
          <View style={[styles.marker, { backgroundColor: theme.color.map.startMarker }]} />
        </Marker>
        <Marker id="finish" lngLat={[finish.longitude, finish.latitude]} anchor="center">
          <View style={[styles.marker, styles.finishMarker, { backgroundColor: theme.color.map.finishMarker }]} />
        </Marker>
      </MapLibreMap>
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

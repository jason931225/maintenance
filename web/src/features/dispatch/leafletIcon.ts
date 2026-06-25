import L from "leaflet";
// Leaflet ships its marker images as files referenced by CSS-relative URLs that
// a bundler cannot resolve on its own. Import them as hashed asset URLs (Vite's
// `?url`) and wire them into Leaflet's default icon so pins render correctly in
// the production build instead of showing broken-image placeholders.
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png?url";
import markerIcon from "leaflet/dist/images/marker-icon.png?url";
import markerShadow from "leaflet/dist/images/marker-shadow.png?url";

let configured = false;

/**
 * Point Leaflet's default marker at the bundled, hash-named icon assets. Safe to
 * call repeatedly; only the first call mutates the prototype.
 */
export function ensureLeafletIcon(): void {
  if (configured) return;
  configured = true;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: markerIcon2x,
    iconUrl: markerIcon,
    shadowUrl: markerShadow,
  });
}

/**
 * Bundle entry for the DSH client half.
 *
 * Styles are imported here only, so the registration module (`mount.tsx`) stays
 * importable from Node-side unit tests without pulling in Tailwind.
 */
import './styles.css'

export * from './mount.js'

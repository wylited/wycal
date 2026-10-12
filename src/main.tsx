/** @jsxImportSource preact */
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './styles/app.css';
// FullCalendar v6 injects its stylesheet at runtime — @fullcalendar/*@6 ships no
// CSS files, so there is nothing to import for it here. styles/theme.css remaps
// every --fc-* custom property onto the Ayu tokens and out-specifies the
// injected rules for the few structural overrides.
import './styles/theme.css';
import { render } from 'preact';
import { App } from './app';

const container = document.getElementById('app');
if (container) {
  render(<App />, container);
}

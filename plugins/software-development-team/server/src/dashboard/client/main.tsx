import { render } from 'preact';
import { App } from './app';

const root = document.getElementById('app');

if (!root) {
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  error.textContent = 'The dashboard could not start because its application root is missing.';
  document.body.append(error);
} else {
  try {
    render(<App />, root);
  } catch (cause) {
    console.error('Dashboard bootstrap failed:', cause);
    root.setAttribute('role', 'alert');
    root.textContent = 'The dashboard could not start. Reload the page to try again.';
  }
}

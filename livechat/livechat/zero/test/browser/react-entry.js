// Only needed when the browser test cannot reach unpkg. Build a local React bundle with:
//   npx esbuild test/browser/react-entry.js --bundle --minify --format=iife \
//     --define:process.env.NODE_ENV='"production"' --outfile=/tmp/react-bundle.js
// then run the test with REACT_BUNDLE=/tmp/react-bundle.js (needs react and react-dom installed).
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
window.React = React;
window.ReactDOM = ReactDOMClient;

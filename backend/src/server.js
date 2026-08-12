import 'dotenv/config';
import { app } from './app.js';

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`[server] World Shiner 2.0 API listening on http://localhost:${port}`);
});

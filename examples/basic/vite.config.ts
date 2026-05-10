import { defineConfig } from 'vite';
import { smitedVite } from '@quantumly-labs/smited-vite';

export default defineConfig({
  plugins: [smitedVite()],
});

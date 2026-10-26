import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Each isolated test process creates its own shared output parent before fixtures.
await mkdir(resolve('.test-output'), { recursive: true });

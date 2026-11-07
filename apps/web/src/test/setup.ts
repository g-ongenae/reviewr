import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The API client grabs `fetch` when its module loads: stub it before any test imports it.
vi.stubGlobal('fetch', vi.fn());

afterEach(cleanup);

// Dev-only: the guard folds to `false` outside `vite --mode mock`, so the mock backend is
// dropped from every other build.

import { installMock } from './mock-ipc.ts'

if (import.meta.env.VITE_MOCK === '1') installMock()

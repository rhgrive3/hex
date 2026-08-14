import fs from 'node:fs';
const path = '.github/workflows/ui-regression.yml';
let text = fs.readFileSync(path, 'utf8');
const a = `      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm run ui:test`;
const b = `      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run ui:test`;
if (!text.includes(a)) throw new Error('architecture install anchor missing');
text = text.replace(a, b);
const c = `      - name: Install Playwright engines
        run: |
          npm install --no-save playwright
          npx playwright install-deps webkit
          npx playwright install chromium webkit`;
const d = `      - name: Install locked dependencies
        run: npm ci
      - name: Install Playwright engines
        run: |
          npx playwright install-deps webkit
          npx playwright install chromium webkit`;
if (!text.includes(c)) throw new Error('browser install anchor missing');
text = text.replace(c, d);
fs.writeFileSync(path, text);

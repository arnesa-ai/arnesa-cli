/**
 * The closed vocabulary of the project profile (design decision 3). Every string of a profile
 * except `model` is a member of one of these lists, so nothing a user wrote can leave the machine.
 * The server keeps a copy (`packages/core/local/domain/vocabulary.ts`); a parity test fails when
 * one side gets a term the other lacks (design decision 2).
 */
export const VOCABULARY = {
  /** File extension (lower case, no dot) to language id. */
  languages: {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    sh: 'shell',
    bash: 'shell',
  },
  /** Dependency name (as it appears in a manifest) to framework id, per ecosystem. */
  frameworks: {
    node: {
      react: 'react',
      'react-dom': 'react',
      next: 'next',
      vue: 'vue',
      nuxt: 'nuxt',
      svelte: 'svelte',
      '@sveltejs/kit': 'sveltekit',
      '@angular/core': 'angular',
      'solid-js': 'solid',
      astro: 'astro',
      express: 'express',
      fastify: 'fastify',
      '@nestjs/core': 'nestjs',
      koa: 'koa',
      hono: 'hono',
      vite: 'vite',
      webpack: 'webpack',
      tailwindcss: 'tailwind',
      jest: 'jest',
      vitest: 'vitest',
      mocha: 'mocha',
      '@playwright/test': 'playwright',
      playwright: 'playwright',
      cypress: 'cypress',
      electron: 'electron',
      'react-native': 'react-native',
      expo: 'expo',
      prisma: 'prisma',
      '@prisma/client': 'prisma',
      'drizzle-orm': 'drizzle',
      typeorm: 'typeorm',
      '@trpc/server': 'trpc',
      graphql: 'graphql',
    },
    python: {
      django: 'django',
      flask: 'flask',
      fastapi: 'fastapi',
      pytest: 'pytest',
      torch: 'pytorch',
      tensorflow: 'tensorflow',
      numpy: 'numpy',
      pandas: 'pandas',
      transformers: 'transformers',
      langchain: 'langchain',
      sqlalchemy: 'sqlalchemy',
      pydantic: 'pydantic',
      scrapy: 'scrapy',
      celery: 'celery',
    },
    go: {
      'github.com/gin-gonic/gin': 'gin',
      'github.com/labstack/echo': 'echo',
      'github.com/gofiber/fiber': 'fiber',
      'github.com/spf13/cobra': 'cobra',
      'google.golang.org/grpc': 'grpc',
      'gorm.io/gorm': 'gorm',
    },
    rust: {
      tokio: 'tokio',
      'actix-web': 'actix',
      axum: 'axum',
      rocket: 'rocket',
      serde: 'serde',
      clap: 'clap',
      bevy: 'bevy',
      diesel: 'diesel',
      sqlx: 'sqlx',
    },
    java: {
      'org.springframework.boot': 'spring-boot',
      'org.junit': 'junit',
    },
  },
  packageManagers: [
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'pip',
    'poetry',
    'uv',
    'cargo',
    'go',
    'maven',
    'gradle',
    'dotnet',
    'bundler',
    'composer',
  ],
  testCommands: [
    'npm test',
    'pnpm test',
    'yarn test',
    'bun test',
    'pytest',
    'go test',
    'cargo test',
    'mvn test',
    'gradle test',
    'dotnet test',
    'make test',
    'unknown',
  ],
  /** Directories and files of agent configuration, counted by the files beneath them. */
  agentConfig: [
    '.claude',
    '.codex',
    '.opencode',
    '.agents',
    '.cursor',
    '.gemini',
    '.github/copilot-instructions.md',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.mcp.json',
    '.cursorrules',
  ],
  runtimes: [
    'claude-code',
    'codex',
    'opencode',
    'antigravity',
    'copilot',
    'cursor',
    'gemini',
    'unknown',
  ],
} as const;

export const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,64}$/;

/** The ids a framework entry can take, as one flat set. */
export function frameworkIds(): string[] {
  const ids = new Set<string>();
  for (const table of Object.values(VOCABULARY.frameworks)) {
    for (const id of Object.values(table)) ids.add(id);
  }
  return [...ids].sort();
}

export function languageIds(): string[] {
  return [...new Set(Object.values(VOCABULARY.languages))].sort();
}

/** Every string a profile may hold other than `model`; the "nothing outside" test checks against it. */
export function allowedStrings(): Set<string> {
  return new Set<string>([
    ...languageIds(),
    ...frameworkIds(),
    ...VOCABULARY.packageManagers,
    ...VOCABULARY.testCommands,
    ...VOCABULARY.agentConfig,
    ...VOCABULARY.runtimes,
  ]);
}

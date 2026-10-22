# Copilot Instructions

This is a Tauri 2 + Vue 3 agent client desktop application.

## Tech Stack
- Frontend: Vue 3 + Vite
- Backend: Tauri 2 (Rust)
- Language: TypeScript, Rust

## Project Conventions
- Use Composition API with `<script setup>` for Vue components
- Use TypeScript for type safety
- Follow Tauri 2 security best practices

## Release & Install Workflow
- **Do not create rollback backups when installing locally.** Do not copy `/Applications/道生一.app` to
  `道生一.app.old-<HHMM>`. This is a pre-release test build; git history and GitHub tags are the record.
  Install directly (`rm -rf` the old bundle, then `ditto` the new one), verify launch, done.
- **Push to GitHub as soon as a change is complete** (`git push origin main`). Do not leave finished
  work sitting in local commits; release commits and their `docs:` follow-ups get pushed right away.


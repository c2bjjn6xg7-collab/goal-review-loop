#!/usr/bin/env node
/**
 * CLI executable entry point for review-loop.
 * This is the file referenced by package.json bin.
 */
import { createCLI } from './index.js';

const program = createCLI();
program.parse(process.argv);

/**
 * The level of a settings Block's title: 3 under a Settings section's h2 (the default); a surface whose page heading
 * is the h1 right above (onboarding's steps) sets 2, so the outline goes up one level at a time (30-a11y). Its own
 * module so onboarding sets it without importing the settings form.
 */
import { createContext } from 'react';

export const BlockHeadingLevel = createContext<2 | 3>(3);

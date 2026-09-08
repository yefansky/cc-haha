import { createContext } from 'react'

// Keep nested tool file actions attached to their owning session, including subagents.
export const ToolCallSessionContext = createContext<string | null>(null)

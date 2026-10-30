import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as log from "@volcanicminds/tools/logger";

export interface WhiteboardNote {
  id: string;
  content: string;
  linkedTo: string[];
}

export interface WhiteboardState {
  mainConcepts: string;
  notes: Record<string, WhiteboardNote>;
}

export let sharedWhiteboardState: WhiteboardState = {
  mainConcepts: "",
  notes: {},
};

export function clearSharedWhiteboard() {
  sharedWhiteboardState = {
    mainConcepts: "",
    notes: {},
  };
}

export const sharedWhiteboardTool = createTool({
  id: "sharedWhiteboardTool",
  description:
    "A shared whiteboard where all debaters can write main concepts, add notes/post-its, and link them together for brainstorming.",
  inputSchema: z.object({
    action: z.enum(["read", "update_main", "add_note", "link_notes"]).describe("The action to perform on the whiteboard."),
    mainText: z.string().optional().describe("Used with 'update_main': The new text to append or set as main concepts."),
    noteContent: z.string().optional().describe("Used with 'add_note': The content of the new note."),
    sourceNoteId: z.string().optional().describe("Used with 'link_notes': The ID of the note that originates the link."),
    targetNoteId: z.string().optional().describe("Used with 'link_notes': The ID of the note being linked to."),
  }),
  execute: async ({ action, mainText, noteContent, sourceNoteId, targetNoteId }) => {
    log.debug(`[sharedWhiteboardTool] Action: ${action}`);

    if (action === "read") {
      return {
        success: true,
        state: sharedWhiteboardState,
      };
    }

    if (action === "update_main") {
      if (!mainText) {
        return { success: false, message: "mainText is required for update_main action" };
      }
      sharedWhiteboardState.mainConcepts = mainText;
      return { success: true, message: "Main concepts updated", state: sharedWhiteboardState };
    }

    if (action === "add_note") {
      if (!noteContent) {
        return { success: false, message: "noteContent is required for add_note action" };
      }
      const noteId = `note-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
      sharedWhiteboardState.notes[noteId] = {
        id: noteId,
        content: noteContent,
        linkedTo: [],
      };
      return { success: true, message: `Note added with ID: ${noteId}`, noteId, state: sharedWhiteboardState };
    }

    if (action === "link_notes") {
      if (!sourceNoteId || !targetNoteId) {
        return { success: false, message: "sourceNoteId and targetNoteId are required for link_notes action" };
      }
      if (!sharedWhiteboardState.notes[sourceNoteId] || !sharedWhiteboardState.notes[targetNoteId]) {
        return { success: false, message: "One or both note IDs do not exist" };
      }

      if (!sharedWhiteboardState.notes[sourceNoteId].linkedTo.includes(targetNoteId)) {
        sharedWhiteboardState.notes[sourceNoteId].linkedTo.push(targetNoteId);
      }
      return { success: true, message: `Note ${sourceNoteId} linked to ${targetNoteId}`, state: sharedWhiteboardState };
    }

    return { success: false, message: "Unknown action" };
  },
});

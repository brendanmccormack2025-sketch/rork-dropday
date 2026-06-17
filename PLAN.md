# Add Undo/Redo to the video editor


## Features

- [x] **Undo button** visible in the editor toolbar — reverts the most recent editing action (trim, split, reorder, delete, text changes)
- [x] **Redo button** visible next to Undo — restores an action that was just undone
- [x] **Multiple Undo/Redo in sequence** — you can step backward and forward through up to 50 editing actions
- [x] **Works for both photos and videos** — any change to clips or text overlays can be undone
- [x] **Non-destructive** — changes only affect the current editing session and never modify the original media files

## Design

- Two circular icon buttons placed at the right side of the top bar (opposite the back arrow)
- Undo icon (curved arrow pointing left) and Redo icon (curved arrow pointing right)
- Buttons are disabled and dimmed when there's nothing to undo or redo
- Subtle haptic feedback on press
- The buttons sit alongside the existing top bar elements with the same glassy circular style

## How it works

- Before each editing action (trim release, split, delete clip, add/edit/remove text, cycle text style, drag/move/resize text), the current state is saved in a history
- Pressing Undo restores the previous state and pushes the current state onto the Redo stack
- Pressing Redo restores the most recently undone state
- Starting a new edit after undoing clears the Redo stack (standard undo/redo behavior)

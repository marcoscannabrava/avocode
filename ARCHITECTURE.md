# Game Agent Architecture

## 1. Model
1. Given game board: S_i (State i)
2. Model the game: M_i (Model i).

The model should contain all relevant data structures in the game.

Example:

State:
```json
{
    "game_board_grid": [
        ["0","0","X","0","0","G"],
        ["0","0","X","0","0","0"],
        ["0","0","X","0","Y","0"],
        ["A","A","0","0","Y","0"],
    ]
}
```

Model:
```json
{
    "element_breakdown": {
        "XXX": "Clickable",
        "YY": "Wall",
        "AA": "Player",
        "G": "Goal"
    },
    "allowable_actions": ["..."],
    "prompt": "The objective of the game is to move Player using keyboard arrows to reach the Goal in the minimum number of moves without hitting a Wall. The Clickable element changes the grid."
}
```

## 2. Agent and Game Interaction

Player Agent: `Player(M_i, S_i) = a_{i+1}`
Next Action is a function of the Agent given the current Model and State.

Game Engine: `Game(S_i, a_{i+1}) = S_{i+1}`
Next State is a function of the Game Engine given the current State and Next Action

Scorer Agent: `Scorer(S_{i-1}, S_i) = M_{i+1}, status`
Next Model is a function of the Scorer given the Previous and Current State. 
Status can be 'success', 'ongoing', 'failed'.
- `success` status does not need to update the Model and indicates the game is over.
- `failed` status indicates the game should be replayed and Model should be updated.
- `ongoing` status indicates the Model may need to be updated.

Architecture:

- Player Agent and Scorer Agent → Clean-context LLMs
- Game → Deterministic Game Engine code

## 3. Loop

Repeat until: `status == 'success'`
Scorer should determine if current State hits a success condition
A memory of failed runs and hypothesis for the reasons should be kept in the Model.

## 4. Rules between games

Each game starts with an empty Model. Some ideas apply to many games.

- At the end of a game, the Scorer reads the final Model and the old rules.
- The Scorer returns a new list of rules: at most 12 short sentences.
- The rules tell how games often work. They do not tell facts about one game.
- The next game gets the rules at its start. The Player sees them in its prompt.
- The Player uses the rules as first guesses. The Model of the game wins.
- The runner keeps one list for the run. A lock lets one game update it at a time.
- Games that end in `aborted` or `error` do not update the rules.
- Use `--no-carry-rules` or `AVOCODE_CARRY_RULES=0` to stop this.
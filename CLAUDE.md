# Casino Games - Texas Hold'em Poker Implementation Plan

## Project Overview
This is a casino games application with React/TypeScript frontend and FastAPI/Python backend. The poker implementation uses WebSockets for real-time gameplay following a server-authoritative architecture.

## Texas Hold'em Game Flow

### Pre-Hand Setup
1. **Dealer Button Rotation**: Moves clockwise to next active player each hand
2. **Blind Posting**: Small blind (left of dealer), Big blind (left of small blind)
3. **Card Dealing**: 2 hole cards to each active player
4. **Initial Bet**: Current bet starts at big blind amount

### Betting Round Mechanics
- **Action Order**: Clockwise from designated starting position
- **Pre-flop**: Starts left of big blind (Under the Gun)
- **Post-flop/turn/river**: Starts left of dealer button (first active player)
- **Round Completion**: All active players have either folded, called current bet, or gone all-in
- **Betting Actions**:
  - **Fold**: Forfeit hand and all bets
  - **Check**: Pass action (only when no bet to call)
  - **Call**: Match current bet amount
  - **Bet**: Make first bet of the round (when current bet is 0)
  - **Raise**: Increase current bet (minimum = previous bet/raise amount)

### Street Progression
1. **Pre-flop**: 2 hole cards + betting round
2. **Flop**: Deal 3 community cards + betting round
3. **Turn**: Deal 1 community card + betting round  
4. **River**: Deal 1 community card + betting round
5. **Showdown**: Determine winners and distribute pots

## Architecture Design

### Core Principles
1. **Server Authority**: Backend maintains single source of truth for all game state
2. **Deterministic Flow**: Predictable state transitions with clear rules
3. **Event-Driven**: Actions trigger events that update state atomically
4. **Separation of Concerns**: Game logic (backend) vs presentation (frontend)
5. **Resilient Client**: Frontend handles any valid server state gracefully

### Backend Architecture

#### Game State Management
```python
@dataclass
class GameState:
    # Table configuration
    table_id: str
    seats: List[Seat]  # Fixed seat positions
    
    # Hand state (None when no active hand)
    hand: Optional[HandState] = None
    
    # Game flow control
    dealer_position: int = 0
    next_hand_id: int = 1
    
@dataclass 
class HandState:
    hand_id: int
    
    # Hand setup
    dealer_seat: int
    small_blind_seat: int
    big_blind_seat: int
    deck_commit: str  # For provable fairness
    
    # Game progression
    stage: str  # "preflop" | "flop" | "turn" | "river" | "showdown"
    board: List[Tuple[int, str]]  # Community cards
    
    # Players and actions
    players: Dict[int, PlayerInHand]  # seat_no -> player state
    action_queue: List[PendingAction]
    
    # Betting state
    current_bet: int = 0
    minimum_raise: int = 0
    to_act: Optional[int] = None
    
    # Pot and results
    pots: List[SidePot] = field(default_factory=list)
    winners: List[Winner] = field(default_factory=list)
```

#### State Machine
```python
class PokerStateMachine:
    """Handles all game state transitions"""
    
    def start_hand(self) -> List[Event]:
        """Initialize new hand with dealer rotation and blind posting"""
        
    def process_action(self, seat_no: int, action: PlayerAction) -> List[Event]:
        """Validate and process player action"""
        
    def advance_street(self) -> List[Event]:
        """Progress from preflop -> flop -> turn -> river -> showdown"""
        
    def complete_betting_round(self) -> List[Event]:
        """End betting round when all players have acted"""
        
    def determine_winners(self) -> List[Event]:
        """Calculate hand rankings and distribute pots"""
```

#### Event System
```python
class Event:
    event_type: str
    data: Dict[str, Any]
    timestamp: float

# Event Types:
- HAND_STARTED
- BLINDS_POSTED  
- CARDS_DEALT
- STREET_REVEALED (flop/turn/river)
- ACTION_REQUIRED
- PLAYER_ACTED
- BETTING_COMPLETE
- POT_AWARDED
- HAND_COMPLETE
```

### Frontend Architecture

#### State Management
```typescript
interface GameState {
  // Server-provided state (read-only)
  table: TableInfo
  seats: Seat[]
  hand: HandState | null
  
  // Local UI state
  selectedAction: ActionType | null
  betAmount: number
  showCards: boolean
  animating: boolean
}

// Single state update from server
interface StateUpdate {
  type: 'FULL_STATE' | 'EVENT'
  data: GameState | Event
}
```

#### Component Responsibilities
- **PokerTable**: Main container, handles WebSocket connection
- **GameBoard**: Displays community cards and pot
- **PlayerSeat**: Shows individual player state and cards
- **ActionPanel**: Betting controls and action buttons
- **HandHistory**: Shows recent actions and results

#### Animation Strategy
```typescript
// Animations are purely cosmetic and don't affect game state
interface Animation {
  type: 'CARD_DEAL' | 'CHIP_MOVE' | 'WINNER_HIGHLIGHT'
  duration: number
  onComplete?: () => void
}

// Animations triggered by state changes, not game events
function useAnimations(gameState: GameState) {
  // When hand.board changes, animate card reveals
  // When pots awarded, animate chip movements  
  // When winners determined, highlight winning hands
}
```

## Implementation Plan

### Phase 1: Core Game Engine (Backend)
**Priority: Critical**

#### 1.1 State Machine Implementation
- Clean game state data structures
- Deterministic state transitions
- Action validation and processing
- Turn management and betting round logic

#### 1.2 Hand Evaluation System
- 7-card hand evaluation (hole + community cards)
- Tie-breaking and kicker logic
- Side pot calculation for all-in scenarios
- Winner determination and pot distribution

#### 1.3 Event Broadcasting
- Atomic state updates via WebSocket
- Player-specific data filtering (hole cards)
- Reliable message delivery
- State synchronization

### Phase 2: Frontend Redesign
**Priority: High**

#### 2.1 State Synchronization
- Single source of truth from server
- Optimistic UI updates for responsiveness
- Graceful handling of state conflicts
- Reconnection and resync logic

#### 2.2 Clean Component Architecture
- Separate game logic from presentation
- Reusable poker components
- Consistent state management
- Error boundary handling

#### 2.3 Visual Polish
- Smooth card reveal animations
- Chip movement effects
- Winner highlighting
- Action feedback

### Phase 3: Advanced Features
**Priority: Medium**

#### 3.1 Tournament Support
- Blind level progression
- Elimination tracking
- Prize pool distribution
- Multi-table tournaments

#### 3.2 Analytics and Logging
- Hand history tracking
- Player statistics
- Game audit logs
- Performance monitoring

#### 3.3 Customization
- Table themes and layouts
- Sound effects and music
- Player avatars and customization
- Mobile-responsive design

## Communication Protocol

### WebSocket Messages

#### Client to Server
```typescript
// Player actions
{
  type: "PLAYER_ACTION"
  action: "fold" | "check" | "call" | "bet" | "raise"
  amount?: number  // For bet/raise actions
}

// Table management
{
  type: "JOIN_TABLE" | "LEAVE_TABLE" | "SIT_DOWN" | "STAND_UP"
  seat_no?: number
  buy_in?: number
}
```

#### Server to Client
```typescript
// Complete game state (sent on join/reconnect)
{
  type: "GAME_STATE"
  table: TableInfo
  seats: Seat[]
  hand: HandState | null
  your_seat?: number
}

// Incremental updates (sent during gameplay)
{
  type: "GAME_EVENT" 
  event: Event
  new_state: Partial<GameState>
}
```

## Data Models

### Table and Player Management
```python
@dataclass
class TableConfig:
    table_id: str
    name: str
    max_seats: int = 6
    small_blind: int = 50   # cents
    big_blind: int = 100    # cents 
    min_buy_in: int = 2000  # cents
    max_buy_in: int = 20000 # cents
    auto_start: bool = False

@dataclass
class Seat:
    seat_no: int
    user_id: Optional[int] = None
    username: Optional[str] = None
    stack: int = 0  # cents
    is_sitting_out: bool = False
    is_connected: bool = True

@dataclass
class PlayerInHand:
    user_id: int
    seat_no: int
    hole_cards: List[Tuple[int, str]]  # [(rank, suit), ...]
    
    # Betting state
    has_folded: bool = False
    is_all_in: bool = False
    street_contribution: int = 0  # Amount bet this street
    total_contribution: int = 0   # Amount bet this hand
    
    # Results
    hand_ranking: Optional[Tuple] = None
    winning_cards: List[int] = field(default_factory=list)
```

### Hand Evaluation
```python
@dataclass
class HandResult:
    player_seat: int
    ranking: Tuple[int, ...]  # For comparison (higher is better)
    hand_type: str           # "Full House", "Flush", etc.
    description: str         # "Kings full of Aces"
    winning_hole_indices: List[int]   # Which hole cards used
    winning_board_indices: List[int]  # Which community cards used

@dataclass  
class SidePot:
    amount: int
    eligible_seats: List[int]
    winners: List[int] = field(default_factory=list)

@dataclass
class Winner:
    seat_no: int
    amount_won: int
    hand_result: HandResult
    pot_index: int = 0  # 0 = main pot, 1+ = side pots
```

## Testing Strategy

### Backend Testing
- **Unit Tests**: State machine transitions, hand evaluation, pot calculation
- **Integration Tests**: Complete hand workflows, edge cases
- **Load Testing**: Multiple concurrent games, WebSocket performance
- **Regression Tests**: Previously fixed bugs

### Frontend Testing
- **Component Tests**: UI components render correctly
- **State Tests**: State management and synchronization
- **Integration Tests**: WebSocket communication
- **E2E Tests**: Complete game scenarios

### Test Scenarios
- **Normal Flow**: Complete hand from start to finish
- **Edge Cases**: All-ins, side pots, disconnections
- **Error Conditions**: Invalid actions, network issues
- **Performance**: Large number of simultaneous players

## Development Commands

### Backend
```bash
# Start development server
uvicorn api.app:app --reload --port 8000

# Run tests
python -m pytest api/tests/

# Type checking
mypy api/
```

### Frontend
```bash
# Start development server
cd client && npm run dev

# Run tests
npm test

# Type checking  
npm run type-check

# Build for production
npm run build
```

## Migration Strategy

### Phase 1: Backend Refactor
1. Create new state machine alongside existing code
2. Implement comprehensive test suite
3. Gradually migrate game flow to new system
4. Maintain backward compatibility during transition

### Phase 2: Frontend Simplification
1. Remove complex board writer system
2. Implement server-state-driven UI
3. Add proper error boundaries and loading states
4. Remove client-side game logic

### Phase 3: Polish and Optimization
1. Add animations and visual effects
2. Optimize WebSocket message frequency
3. Implement proper error handling
4. Performance tuning and monitoring

This comprehensive plan provides a solid foundation for a robust, maintainable poker implementation that follows industry best practices for real-time multiplayer games.
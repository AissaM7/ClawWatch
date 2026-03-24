# ClawWatch

ClawWatch is a comprehensive observability tool that provides deep insights into agent-user interactions, tracking LLM calls, tool usage, context, and user prompts. Designed for seamless integration with agent frameworks, it visualizes these interactions in an intuitive, hierarchical timeline to help developers debug, trace, and monitor their AI agents effectively.

## Project Structure

This repository contains two main components:

### 1. `clawwatch-plugin`
The OpenClaw plugin acts as the data interception and processing layer.
- Captures and logs all agent activities, including web searches, local tool execution, and LLM inferences.
- Ensures user prompts are accurately captured by stripping redundant metadata wrappers.
- Scores tasks based on Risk, Hallucination probability, and Goal Alignment.

### 2. `clawwatch-ui`
The React-based frontend that visualizes the captured data.
- **Hierarchical Visualization**: Organizes data into Thread → Task → Exchange structures.
- **Agent Interaction Observability**: Features bold, color-coded visual indicators for agent behaviors (e.g., LLM calls, web searches), directly embedded within the task view.
- **Dynamic Content Support**: Fully supports dynamic-height wrap for user prompts, ensuring no data is ever truncated.

## Getting Started

### Prerequisites
- Node.js (for the UI)
- OpenClaw or equivalent agentic framework (for the plugin)
- Python (if the plugin relies on a python backend, depending on the environment)

### Running the Application

**UI Development Server:**
```bash
cd clawwatch-ui
npm install # if not already installed
npm run dev
```

**Plugin Startup:**
Navigate to the `clawwatch-plugin` directory and start the appropriate backend server or script depending on the plugin environment setup.

## Features Let's Explore
- **Granular Timeline**: Expand/collapse Tasks and Exchanges to dig deep into specific step executions.
- **Action Triggers**: Immediate visual representation of LLM decisions and operations.
- **Data Integrity**: Clean metadata handling to ensure observability is not cluttered with unnecessary protocol wrappers.

## Contributing
Feel free to open issues or submit PRs to improve tracking metrics, visual cues, or add new integrations.

## License
MIT

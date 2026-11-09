"""Make an LLM client by provider name."""

from __future__ import annotations

from avocode.ports import LLMClient


def make_client(provider: str, effort: str = "") -> LLMClient:
    """Anthropic, OpenAI, or OpenRouter client."""
    if provider == "openrouter":
        from avocode.llm.openrouter import OpenRouterClient

        return OpenRouterClient(effort=effort)
    if provider == "openai":
        from avocode.llm.openai import OpenAIClient

        return OpenAIClient(effort=effort)
    if provider == "anthropic":
        from avocode.llm.anthropic import AnthropicClient

        return AnthropicClient()
    raise ValueError(f"unknown LLM provider: {provider}")

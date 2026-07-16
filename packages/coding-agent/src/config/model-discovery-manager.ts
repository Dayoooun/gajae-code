export interface DiscoveryProvider {
	provider: string;
}

/** Owns configured discovery catalog inputs and their observable provider status. */
export class ModelDiscoveryManager<TProvider extends DiscoveryProvider, TState> {
	#providers: TProvider[] = [];
	#states = new Map<string, TState>();

	reset(): void {
		this.#providers = [];
		this.#states.clear();
	}

	setProviders(providers: readonly TProvider[]): void {
		this.#providers = [...providers];
	}

	addProvider(provider: TProvider): void {
		this.#providers.push(provider);
	}

	get providers(): readonly TProvider[] {
		return this.#providers;
	}

	providerIds(): Set<string> {
		return new Set(this.#providers.map(provider => provider.provider));
	}

	getState(provider: string): TState | undefined {
		return this.#states.get(provider);
	}

	setState(provider: string, state: TState): void {
		this.#states.set(provider, state);
	}
}

export interface DiscoveryProvider {
	provider: string;
}

export interface DiscoveryRefreshToken {
	provider: string;
	generation: number;
}

export interface DiscoveryRefreshResult<TResult> {
	current: boolean;
	value: TResult;
}

/** Owns configured discovery inputs, provider state, and refresh generations. */
export class ModelDiscoveryManager<TProvider extends DiscoveryProvider, TState> {
	#providers: TProvider[] = [];
	#states = new Map<string, TState>();
	#refreshGenerations = new Map<string, number>();

	reset(): void {
		for (const provider of this.#providers) this.#invalidate(provider.provider);
		this.#providers = [];
		this.#states.clear();
	}

	setProviders(providers: readonly TProvider[]): void {
		const previousProviderIds = new Set(this.#providers.map(provider => provider.provider));
		this.#providers = providers.map(provider => this.#snapshot(provider));
		for (const provider of this.#providers) previousProviderIds.add(provider.provider);
		for (const providerId of previousProviderIds) this.#invalidate(providerId);
		this.#states.clear();
	}

	addProvider(provider: TProvider): void {
		this.#providers.push(this.#snapshot(provider));
		this.#invalidate(provider.provider);
		this.#states.delete(provider.provider);
	}

	get providers(): readonly TProvider[] {
		return this.#providers.map(provider => this.#snapshot(provider));
	}

	providerIds(): Set<string> {
		return new Set(this.#providers.map(provider => provider.provider));
	}

	getState(provider: string): TState | undefined {
		const state = this.#states.get(provider);
		return state === undefined ? undefined : this.#snapshot(state);
	}

	setState(provider: string, state: TState, token?: DiscoveryRefreshToken): boolean {
		if (token && !this.isCurrent(token)) return false;
		this.#states.set(provider, this.#snapshot(state));
		return true;
	}

	beginRefresh(provider: string): DiscoveryRefreshToken {
		const generation = this.#invalidate(provider);
		return { provider, generation };
	}

	isCurrent(token: DiscoveryRefreshToken): boolean {
		return (
			this.#refreshGenerations.get(token.provider) === token.generation &&
			this.#providers.some(provider => provider.provider === token.provider)
		);
	}

	async refresh<TResult>(
		provider: string,
		fetch: (token: DiscoveryRefreshToken) => Promise<TResult>,
	): Promise<DiscoveryRefreshResult<TResult>> {
		const token = this.beginRefresh(provider);
		const value = await fetch(token);
		return { current: this.isCurrent(token), value };
	}

	#invalidate(provider: string): number {
		const generation = (this.#refreshGenerations.get(provider) ?? 0) + 1;
		this.#refreshGenerations.set(provider, generation);
		return generation;
	}

	#snapshot<T>(value: T): T {
		return structuredClone(value);
	}
}

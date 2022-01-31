import { CreaturePF2e } from "@actor";
import { TokenDocumentPF2e } from "@module/scene";
import { MeasuredTemplatePF2e, TokenLayerPF2e } from ".";

export class TokenPF2e extends Token<TokenDocumentPF2e> {
    /** Used to track conditions and other token effects by game.pf2e.StatusEffects */
    statusEffectChanged = false;

    /** The promise returned by the last call to `Token#draw()` */
    private drawLock?: Promise<this>;

    /** Is the user currently controlling this token? */
    get isControlled(): boolean {
        return this._controlled;
    }

    /** Is this token currently moving? */
    get isMoving(): boolean {
        return !!this._movement;
    }

    /** Is this token emitting light with a negative value */
    get emitsDarkness(): boolean {
        return this.document.emitsDarkness;
    }

    /** Is rules-based vision enabled, and does this token's actor have low-light vision (inclusive of darkvision)? */
    get hasLowLightVision(): boolean {
        return this.document.hasLowLightVision;
    }

    /** Is rules-based vision enabled, and does this token's actor have darkvision vision? */
    get hasDarkvision(): boolean {
        return this.document.hasDarkvision;
    }

    /** Is this token's dimensions linked to its actor's size category? */
    get linkToActorSize(): boolean {
        return this.data.flags.pf2e.linkToActorSize;
    }

    /** Determine whether this token can flank another—given that they have a flanking buddy on the opposite side */
    canFlank(flankee: TokenPF2e): boolean {
        if (this === flankee) return false;

        // Only PCs and NPCs can flank
        if (!(this.actor && ["character", "npc"].includes(this.actor.type))) return false;
        // Only creatures can be flanked
        if (!(flankee.actor instanceof CreaturePF2e)) return false;

        // Allies don't flank each other
        const areAlliedTokens =
            [this, flankee].every((t) => t.actor!.hasPlayerOwner ?? false) ||
            ![this, flankee].some((t) => t.actor!.hasPlayerOwner ?? false);
        if (areAlliedTokens) return false;

        const reach = this.actor.getReach({ to: "attack" });

        return this.actor.canAttack && reach >= this.distanceTo(flankee, { reach });
    }

    /** Determine whether this token is in fact flanking another */
    isFlanking(flankee: TokenPF2e): boolean {
        if (!this.canFlank(flankee)) return false;

        // Return true if a flanking buddy is found
        const { lineCircleIntersection, lineSegmentIntersects } = foundry.utils;

        const areOnOppositeCorners = (flankerA: TokenPF2e, flankerB: TokenPF2e, flankee: TokenPF2e): boolean =>
            lineCircleIntersection(flankerA.center, flankerB.center, flankee.center, 1).intersections.length > 0;

        const areOnOppositeSides = (flankerA: TokenPF2e, flankerB: TokenPF2e, flankee: TokenPF2e): boolean => {
            const [centerA, centerB] = [flankerA.center, flankerB.center];
            const { bounds } = flankee;

            const leftSide = (): [Point, Point] => [
                { x: bounds.left, y: bounds.top },
                { x: bounds.left, y: bounds.bottom },
            ];
            const rightSide = (): [Point, Point] => [
                { x: bounds.right, y: bounds.top },
                { x: bounds.right, y: bounds.bottom },
            ];
            const topSide = (): [Point, Point] => [
                { x: bounds.left, y: bounds.top },
                { x: bounds.right, y: bounds.top },
            ];
            const bottomSide = (): [Point, Point] => [
                { x: bounds.left, y: bounds.bottom },
                { x: bounds.right, y: bounds.bottom },
            ];

            return (
                (lineSegmentIntersects(centerA, centerB, ...leftSide()) &&
                    lineSegmentIntersects(centerA, centerB, ...rightSide())) ||
                (lineSegmentIntersects(centerA, centerB, ...topSide()) &&
                    lineSegmentIntersects(centerA, centerB, ...bottomSide()))
            );
        };

        const isAFlankingArrangement = (flankerA: TokenPF2e, flankerB: TokenPF2e, flankee: TokenPF2e): boolean =>
            areOnOppositeCorners(flankerA, flankerB, flankee) || areOnOppositeSides(flankerA, flankerB, flankee);

        return canvas.tokens.placeables.some(
            (t) => t !== this && t.canFlank(flankee) && isAFlankingArrangement(this, t, flankee)
        );
    }

    /** Max the brightness emitted by this token's `PointSource` if any controlled token has low-light vision */
    override updateSource({ defer = false, deleted = false, skipUpdateFog = false } = {}): void {
        if (this.actor?.type === "npc" || !(canvas.sight.hasLowLightVision || canvas.sight.hasDarkvision)) {
            return super.updateSource({ defer, deleted, skipUpdateFog });
        }

        const original = { dim: this.data.light.dim, bright: this.data.light.bright };
        this.data.light.bright = Math.max(original.dim, original.bright);
        this.data.light.dim = 0;

        super.updateSource({ defer, deleted, skipUpdateFog });

        this.data.light.bright = original.bright;
        this.data.light.dim = original.dim;
    }

    /** Make the drawing promise accessible to `#redraw` */
    override async draw(): Promise<this> {
        this.drawLock = super.draw();
        await this.drawLock;
        return this;
    }

    /** Refresh this token's image and size (usually after an actor update or override) */
    async redraw(): Promise<void> {
        await this.drawLock;

        // Exit early if icon isn't fully loaded
        if (!(this.icon?.transform?.scale && this.icon.texture?.orig)) {
            return;
        }

        const sizeChanged = !!this.hitArea && this.linkToActorSize && this.w !== this.hitArea.width;
        const scaleChanged = ((): boolean => {
            const expectedScale =
                (Math.round((this.texture.orig.width / this.texture.orig.height) * 10) / 10) * this.data.scale;
            return Math.round((this.icon.width / this.w) * 10) / 10 !== expectedScale;
        })();
        const imageChanged = this.icon.src !== this.data.img;

        if ((sizeChanged || scaleChanged || imageChanged) && this.actor?.type !== "vehicle") {
            console.debug("PF2e System | Redrawing due to token size or image change");
            const { visible } = this;
            this.drawLock = this.draw();
            await this.drawLock;
            this.visible = visible;
        }
    }

    emitHoverIn() {
        this.emit("mouseover", { data: { object: this } });
    }

    emitHoverOut() {
        this.emit("mouseout", { data: { object: this } });
    }

    /** Set the icon src when drawing for later tracking */
    protected override async _drawIcon(): Promise<TokenImage> {
        const icon: TokenImage = await super._drawIcon();
        icon.src = this.data.img;
        return icon;
    }

    /** If Party Vision is enabled, make all player-owned actors count as vision sources for non-GM users */
    protected override _isVisionSource(): boolean {
        const partyVisionEnabled =
            !!this.actor?.hasPlayerOwner && !game.user.isGM && game.settings.get("pf2e", "metagame.partyVision");
        return partyVisionEnabled || super._isVisionSource();
    }

    /** Include actor overrides in the clone if it is a preview */
    override clone(): this {
        const clone = super.clone();
        if (!clone.id) {
            clone.data.height = this.data.height;
            clone.data.width = this.data.width;
            clone.data.img = this.data.img;
        }

        return clone;
    }

    /** Emit floaty text from this tokens */
    async showFloatyText(params: number | ShowFloatyEffectParams): Promise<void> {
        const scrollingTextArgs = ((): Parameters<ObjectHUD<TokenPF2e>["createScrollingText"]> | null => {
            if (typeof params === "number") {
                const quantity = params;
                const maxHP = this.actor?.hitPoints?.max;
                if (!(quantity && typeof maxHP === "number")) return null;

                const percent = Math.clamped(Math.abs(quantity) / maxHP, 0, 1);
                const textColors = {
                    damage: 16711680, // reddish
                    healing: 65280, // greenish
                };
                return [
                    params.signedString(),
                    {
                        anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
                        jitter: 0.25,
                        fill: textColors[quantity < 0 ? "damage" : "healing"],
                        fontSize: 16 + 32 * percent, // Range between [16, 48]
                        stroke: 0x000000,
                        strokeThickness: 4,
                    },
                ];
            } else {
                const [change, details] = Object.entries(params)[0];
                const isAdded = change === "create";
                const sign = isAdded ? "+ " : "- ";
                const appendedNumber = details.value ? ` ${details.value}` : "";
                const content = `${sign}${details.name}${appendedNumber}`;

                return [
                    content,
                    {
                        anchor: change === "create" ? CONST.TEXT_ANCHOR_POINTS.TOP : CONST.TEXT_ANCHOR_POINTS.BOTTOM,
                        direction: isAdded ? 2 : 1,
                        jitter: 0.25,
                        fill: "white",
                        fontSize: 32,
                        stroke: 0x000000,
                        strokeThickness: 4,
                    },
                ];
            }
        })();
        if (!scrollingTextArgs) return;

        await this.drawLock;
        await this.hud?.createScrollingText(...scrollingTextArgs);
    }

    /**
     * Measure the distance between this token and another object, in grid distance. We measure between the
     * centre of squares, and if either covers more than one square, we want the minimum distance between
     * any two of the squares.
     */
    distanceTo(target: TokenPF2e, { reach = null }: { reach?: number | null } = {}): number {
        if (!canvas.dimensions) return NaN;

        if (canvas.grid.type !== CONST.GRID_TYPES.SQUARE) {
            return canvas.grid.measureDistance(this.position, target.position);
        }

        const gridSize = canvas.dimensions.size;

        const tokenRect = (token: TokenPF2e): PIXI.Rectangle => {
            return new PIXI.Rectangle(
                token.x + gridSize / 2,
                token.y + gridSize / 2,
                token.w - gridSize,
                token.h - gridSize
            );
        };

        return MeasuredTemplatePF2e.measureDistanceRect(tokenRect(this), tokenRect(target), { reach });
    }

    /* -------------------------------------------- */
    /*  Event Listeners and Handlers                */
    /* -------------------------------------------- */

    /** Refresh vision and the `EffectsPanel` */
    protected override _onControl(options: { releaseOthers?: boolean; pan?: boolean } = {}): void {
        if (game.ready) game.pf2e.effectPanel.refresh();
        super._onControl(options);
        canvas.lighting.setPerceivedLightLevel(this);
    }

    /** Refresh vision and the `EffectsPanel` */
    protected override _onRelease(options?: Record<string, unknown>) {
        game.pf2e.effectPanel.refresh();

        canvas.lighting.setPerceivedLightLevel();
        super._onRelease(options);
    }
}

interface TokenImage extends PIXI.Sprite {
    src?: VideoPath;
}

export interface TokenPF2e extends Token<TokenDocumentPF2e> {
    get layer(): TokenLayerPF2e<this>;

    icon?: TokenImage;
}

type NumericFloatyEffect = { name: string; value?: number | null };
type ShowFloatyEffectParams =
    | number
    | { create: NumericFloatyEffect }
    | { update: NumericFloatyEffect }
    | { delete: NumericFloatyEffect };

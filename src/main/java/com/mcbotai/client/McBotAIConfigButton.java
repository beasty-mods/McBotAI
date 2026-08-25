package com.mcbotai.client;

import com.mojang.blaze3d.matrix.MatrixStack;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.AbstractGui;
import net.minecraft.client.gui.widget.button.Button;
import net.minecraft.util.ResourceLocation;
import net.minecraft.util.text.StringTextComponent;

public class McBotAIConfigButton extends Button {

    private static final ResourceLocation ICON =
            new ResourceLocation("mcbotai", "textures/gui/mcbotai_config.png");

    // The actual source PNG is only 9x11 pixels. This has to match the
    // real file, since it's used to normalize the blit's texture
    // coordinates below (getting it wrong is what caused the smeared/
    // corrupted icon rendering).
    private static final int ICON_TEX_WIDTH = 9;
    private static final int ICON_TEX_HEIGHT = 11;

    public McBotAIConfigButton(int x, int y, int width, int height, IPressable pressable) {
        super(
                x,
                y,
                width,
                height,
                new StringTextComponent(""),
                pressable
        );
    }

    @Override
    public void renderButton(MatrixStack matrixStack, int mouseX, int mouseY, float partialTicks) {

        // NOTE: deliberately NOT calling super.renderButton() here.
        // Vanilla Button's background texture is only laid out for
        // ~20px-tall buttons; at larger sizes it samples outside its
        // intended texture row and bleeds into unrelated art, which is
        // what produced the warped/corrupted look. Draw a simple custom
        // square frame instead, sized correctly for this button.
        boolean hovered = this.isHovered();

        int x1 = this.x;
        int y1 = this.y;
        int x2 = this.x + this.width;
        int y2 = this.y + this.height;

        // Outer black border
        AbstractGui.fill(matrixStack, x1, y1, x2, y2, 0xFF000000);

        // Button face, 1px in from the border, lighter on hover
        int faceColor = hovered ? 0xFF8B8B8B : 0xFF6B6B6B;
        AbstractGui.fill(matrixStack, x1 + 1, y1 + 1, x2 - 1, y2 - 1, faceColor);

        // Small bevel highlight (top/left) and shadow (bottom/right) for
        // a slight 3D button feel, matching vanilla widget styling.
        AbstractGui.fill(matrixStack, x1 + 1, y1 + 1, x2 - 1, y1 + 2, 0xFFA0A0A0);
        AbstractGui.fill(matrixStack, x1 + 1, y1 + 1, x1 + 2, y2 - 1, 0xFFA0A0A0);
        AbstractGui.fill(matrixStack, x1 + 1, y2 - 2, x2 - 1, y2 - 1, 0xFF383838);
        AbstractGui.fill(matrixStack, x2 - 2, y1 + 1, x2 - 1, y2 - 1, 0xFF383838);

        Minecraft minecraft = Minecraft.getInstance();

        // Sprite is drawn a little smaller than the button, instead of
        // filling it, so there's a visible margin around the icon.
        // Scaled off the button's height with the source PNG's native
        // 9:11 aspect ratio preserved, so it doesn't stretch.
        float spriteScale = 3f / 5f;
        int iconHeight = Math.round(this.height * spriteScale);
        int iconWidth = Math.round(iconHeight * (float) ICON_TEX_WIDTH / ICON_TEX_HEIGHT);

        int iconX = this.x + (this.width - iconWidth) / 2;
        int iconY = this.y + (this.height - iconHeight) / 2;

        minecraft.getTextureManager().bind(ICON);

        AbstractGui.blit(
                matrixStack,
                iconX,
                iconY,
                iconWidth,
                iconHeight,
                0,
                0,
                ICON_TEX_WIDTH,
                ICON_TEX_HEIGHT,
                ICON_TEX_WIDTH,
                ICON_TEX_HEIGHT
        );
    }
}
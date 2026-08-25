package com.mcbotai.client;

import com.mojang.blaze3d.matrix.MatrixStack;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.AbstractGui;
import net.minecraft.client.gui.widget.button.Button;
import net.minecraft.util.ResourceLocation;
import net.minecraft.util.text.StringTextComponent;

public class McBotAIButton extends Button {

    private static final ResourceLocation ICON =
            new ResourceLocation("mcbotai", "textures/gui/mcbotai_icon.png");

    public McBotAIButton(int x, int y, int width, int height, IPressable pressable) {
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

        // Draw the normal Minecraft button background
        super.renderButton(matrixStack, mouseX, mouseY, partialTicks);

        Minecraft minecraft = Minecraft.getInstance();

        // Your sprite is 9x11 pixels
        int iconWidth = 9;
        int iconHeight = 11;

        // Gap between icon and text
        int gap = 4;

        // Text
        StringTextComponent text = new StringTextComponent("McBotAI");
        int textWidth = minecraft.font.width(text);

        // Calculate the total width of icon + gap + text
        int totalWidth = iconWidth + gap + textWidth;

        // Center the entire group in the button
        int groupX = this.x + (this.width - totalWidth) / 2;

        // Icon position
        int iconX = groupX;
        int iconY = this.y + (this.height - iconHeight) / 2;

        // Bind texture
        minecraft.getTextureManager().bind(ICON);

        // Draw icon
        AbstractGui.blit(
                matrixStack,
                iconX,
                iconY,
                0,
                0,
                iconWidth,
                iconHeight,
                iconWidth,
                iconHeight
        );

        // Draw text directly beside icon
        int textX = iconX + iconWidth + gap;

        AbstractGui.drawString(
                matrixStack,
                minecraft.font,
                text,
                textX,
                this.y + (this.height - 8) / 2,
                0xFFFFFF
        );
    }
}
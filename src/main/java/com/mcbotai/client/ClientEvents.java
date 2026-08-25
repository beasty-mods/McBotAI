package com.mcbotai.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screen.IngameMenuScreen;
import net.minecraft.client.gui.screen.MainMenuScreen;
import net.minecraft.client.gui.widget.button.Button;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.GuiScreenEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

@Mod.EventBusSubscriber(modid = "mcbotai", value = Dist.CLIENT)
public class ClientEvents {

    @SubscribeEvent
    public static void onGuiInit(GuiScreenEvent.InitGuiEvent event) {

        /*
         * ============================================================
         * MAIN MENU CONFIG BUTTON
         * ============================================================
         */

        if (event.getGui() instanceof MainMenuScreen) {

            Button multiplayerButton = null;

            // Find Minecraft's Multiplayer button.
            for (net.minecraft.client.gui.widget.Widget widget : event.getWidgetList()) {

                if (widget instanceof Button) {

                    Button button = (Button) widget;

                    if (button.getMessage().getString().equals("Multiplayer")) {
                        multiplayerButton = button;
                        break;
                    }
                }
            }

            if (multiplayerButton != null) {

                /*
                 * Square config button. Fixed at 400px^2 of area, i.e.
                 * a 20x20 square (20 * 20 = 400). Placed immediately to
                 * the left of the Multiplayer button, vertically
                 * centered on it.
                 */
                int size = 20;
                int gap = 8;

                int x = multiplayerButton.x - size - gap;

                // Keep it fully on-screen even at small window sizes /
                // high GUI scales, instead of letting it run off the
                // left edge.
                int margin = 8;
                if (x < margin) {
                    x = margin;
                }

                int y = multiplayerButton.y
                        - (size - multiplayerButton.getHeight()) / 2;

                event.addWidget(new McBotAIConfigButton(
                        x,
                        y,
                        size,
                        size,
                        button -> {

                            McBotAIConfig.load();

                            Minecraft.getInstance().setScreen(
                                    new McBotAIConfigScreen(event.getGui())
                            );
                        }
                ));
            }

            return;
        }

        /*
         * ============================================================
         * PAUSE MENU McBotAI BUTTON
         * ============================================================
         */

        if (!(event.getGui() instanceof IngameMenuScreen)) {
            return;
        }

        Button saveQuitButton = null;

        // Find the original Save and Quit button.
        for (net.minecraft.client.gui.widget.Widget widget : event.getWidgetList()) {

            if (widget instanceof Button) {

                Button button = (Button) widget;

                if (button.getMessage().getString().equals("Save and Quit to Title")) {
                    saveQuitButton = button;
                    break;
                }
            }
        }

        if (saveQuitButton == null) {
            return;
        }

        /*
         * Move Save and Quit down by one button row.
         */
        saveQuitButton.y += 24;

        // Add McBotAI directly above it.
        event.addWidget(new McBotAIButton(
                saveQuitButton.x,
                saveQuitButton.y - 24,
                saveQuitButton.getWidth(),
                saveQuitButton.getHeight(),
                button -> {

                    McBotAIConfig.load();

                    Minecraft.getInstance().setScreen(
                            new BotieLauncherScreen(event.getGui())
                    );
                }
        ));
    }
}